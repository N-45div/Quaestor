/**
 * The executor that actually signs and sends a governed trade.
 *
 * Everything above it — discovery, quoting, the policy preview — can run
 * against a simulation. This is the piece that cannot: it builds the
 * `execute_trade` instruction, hands the route through untouched, and submits
 * it. What comes back is what the chain did, not what the quote hoped.
 *
 * Three outcomes, and the difference between them matters to an agent:
 *
 *   settled       the transaction confirmed; the output is read back from the
 *                 IntentRecord the program wrote, which is the chain's own
 *                 measurement rather than the quote's expectation
 *   not-executed  the transaction confirmed *and reverted* — a governor refusal
 *                 is a real signature you can open, not an absence
 *   thrown        the network never gave an answer *and still has not* by the
 *                 time the transaction could no longer land. Only then does the
 *                 intent stay pending.
 *
 * The third used to be reached far too easily: any RPC hiccup threw, and a
 * pending intent keeps its reservation against the daily cap and the vault
 * forever. So an ambiguous submission is now settled rather than abandoned. The
 * program writes the intent's record in the same transaction as the trade, so
 * the record exists if and only if the trade happened — and a transaction
 * cannot land once its blockhash has expired. Those two facts turn "unknown"
 * into an answer within about a minute and a half.
 */
import { Connection, Keypair, PublicKey, type AccountMeta } from "@solana/web3.js";
import {
  executeTrade,
  fetchIntentRecord,
  governorPda,
  id32,
  intentPda,
  NotSubmittedError,
  send,
  stubSwapAccounts,
  stubSwapData,
  TxFailure,
  UnresolvedSubmission,
  type RemoteSigner,
  type TransactionSigner,
} from "../solana/client";
import { safeMessage } from "./redact";
import type { JupiterQuote, StockExecutionResult, StockTradeIntent } from "./types";
import type { StockChainExecutor } from "./governor";
import { DEFAULT_VENUE, type VenueId } from "./venues";

/** A venue's swap instruction, as the governor will re-compose it. */
export interface SolanaVenueRoute {
  programId: PublicKey;
  accounts: AccountMeta[];
  data: Buffer;
  /** Signers the venue itself needs. A real aggregator needs none. */
  signers?: Keypair[];
}

export interface RouteRequest {
  intent: StockTradeIntent;
  quote: JupiterQuote;
  amountIn: bigint;
  minOutput: bigint;
}

export interface SolanaRouteBuilder {
  readonly venue: VenueId;
  build(request: RouteRequest): Promise<SolanaVenueRoute>;
}

/** Where a given instrument's position is held. */
export interface SolanaInstrumentAccounts {
  stockAccount: PublicKey;
}

export interface SolanaExecutorConfig {
  connection: Connection;
  /** The owner whose governor PDA this is; it never signs a trade. */
  governorOwner: PublicKey;
  vault: PublicKey;
  /**
   * Only the operator may trade, and only inside the owner's caps. A keypair
   * held here, or a signer whose key is held elsewhere (an MPC wallet).
   */
  operator: Keypair | RemoteSigner;
  /** Pays fees and the IntentRecord's rent. */
  payer: Keypair;
  instruments: Map<string, SolanaInstrumentAccounts>;
  routes: Map<VenueId, SolanaRouteBuilder>;
  cluster?: "devnet" | "mainnet-beta";
  /** How long to keep asking the chain about an ambiguous submission. */
  resolveTimeoutMs?: number;
  resolvePollMs?: number;
}

/** Stands where a signature would, for a trade that never produced one. */
export const NOT_SUBMITTED = "not-submitted";

const hash32 = (hex: string): Buffer => {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`expected a 32-byte hex hash, got "${hex}"`);
  return Buffer.from(raw, "hex");
};

export class SolanaStockExecutor implements StockChainExecutor {
  constructor(private readonly cfg: SolanaExecutorConfig) {}

  explorer(signature: string): string {
    return `https://explorer.solana.com/tx/${signature}?cluster=${this.cfg.cluster ?? "devnet"}`;
  }

  async execute(intent: StockTradeIntent, quote: JupiterQuote): Promise<StockExecutionResult> {
    // By the time this runs the governor has already reserved the amount. So
    // everything up to the send is inside one guard: a misconfiguration, a
    // route that cannot be built or a malformed hash means no transaction, and
    // no transaction must release the reservation rather than strand it.
    let prepared: { instruction: ReturnType<typeof executeTrade>; signers: TransactionSigner[]; record: PublicKey };
    try {
      prepared = await this.prepare(intent, quote);
    } catch (error) {
      console.error("[stocks-executor] not submitted:", safeMessage(error, 200));
      return { txSignature: NOT_SUBMITTED, actualOutput: 0n, outcome: "not-executed" };
    }
    const { instruction, signers: unique, record } = prepared;

    let signature: string;
    try {
      signature = await send(this.cfg.connection, [instruction], unique);
    } catch (error) {
      if (error instanceof TxFailure) {
        // Confirmed and reverted: the governor refused, on chain, with a
        // signature an agent can go and read.
        return { txSignature: error.signature, actualOutput: 0n, outcome: "not-executed" };
      }
      if (error instanceof NotSubmittedError) {
        // Nothing reached the chain, so nothing is at risk, but a signer that
        // keeps failing must not fail silently.
        console.error("[stocks-executor] not submitted:", safeMessage(error.cause, 200));
        return { txSignature: NOT_SUBMITTED, actualOutput: 0n, outcome: "not-executed" };
      }
      if (error instanceof UnresolvedSubmission) {
        const resolved = await this.resolve(record, error.signature, error.lastValidBlockHeight);
        if (resolved) return resolved;
      }
      // The chain could not be asked at all. Left to throw so the intent stays
      // pending: "we could not find out" must never be reported as "it did not
      // happen", because a retry on that basis is how a trade happens twice.
      throw error;
    }

    // Confirmed without error: the trade happened. From here nothing may throw —
    // failing to *read* the record must not turn a known success into a pending
    // intent that holds its reservation forever.
    const measured = await this.resolve(record, signature, Number.MAX_SAFE_INTEGER);
    if (measured) return measured;
    // The chain stayed unreadable for the whole window. The program reverts any
    // fill below the floor, so the floor is a true lower bound on what arrived.
    console.error("[stocks-executor] settled but unread; reporting the enforced floor:", signature);
    return { txSignature: signature, actualOutput: intent.minOutput, outcome: "settled" };
  }

  private async prepare(intent: StockTradeIntent, quote: JupiterQuote) {
    const accounts = this.cfg.instruments.get(intent.instrumentMint);
    if (!accounts) throw new Error(`no position account configured for ${intent.instrumentMint}`);
    const venue = (quote.venue ?? DEFAULT_VENUE) as VenueId;
    const builder = this.cfg.routes.get(venue);
    if (!builder) throw new Error(`no route builder configured for venue "${venue}"`);

    const amountIn = intent.amountInUsdc;
    const minOutput = intent.minOutput;
    const route = await builder.build({ intent, quote, amountIn, minOutput });

    // The on-chain intent id is derived from the platform's, so the same
    // logical intent always lands on the same record PDA — which is what makes
    // a retry a replay the program refuses rather than a second trade.
    const intentId = id32(intent.intentId);
    const instruction = executeTrade({
      operator: this.cfg.operator.publicKey,
      payer: this.cfg.payer.publicKey,
      governorOwner: this.cfg.governorOwner,
      vault: this.cfg.vault,
      instrumentMint: new PublicKey(intent.instrumentMint),
      stockAccount: accounts.stockAccount,
      routerProgram: route.programId,
      intentId,
      decisionHash: hash32(intent.decisionHash),
      decisionRecordHash: hash32(intent.decisionRecordHash),
      amountIn,
      minOutput,
      swapData: route.data,
      remaining: route.accounts,
    });

    const signers: TransactionSigner[] = [this.cfg.payer, this.cfg.operator, ...(route.signers ?? [])];
    // Distinct keys only: the payer and operator may be the same wallet, and
    // signing twice with one key is rejected as a duplicate signature. The
    // payer stays first: a transaction's id is its fee payer's signature.
    const unique = [...new Map(signers.map((s) => [s.publicKey.toBase58(), s])).values()];
    const [record] = intentPda(governorPda(this.cfg.governorOwner)[0], intentId);
    return { instruction, signers: unique, record };
  }

  /**
   * Find out what an ambiguous submission did.
   *
   * Settled if the intent's record exists. Not executed if the chain reports
   * the transaction failed, or if its blockhash has expired and there is still
   * no record — checked once more after the expiry is seen, so a transaction
   * that landed in its very last valid block is not mistaken for one that
   * never did. Null if the chain could not be reached for the whole window.
   */
  private async resolve(
    record: PublicKey,
    signature: string,
    lastValidBlockHeight: number,
  ): Promise<StockExecutionResult | null> {
    const connection = this.cfg.connection;
    const deadline = Date.now() + (this.cfg.resolveTimeoutMs ?? 100_000);
    const settledFrom = async (): Promise<StockExecutionResult | null> => {
      const found = await fetchIntentRecord(connection, record);
      return found ? { txSignature: signature, actualOutput: found.actualOutput, outcome: "settled" } : null;
    };
    const notExecuted: StockExecutionResult = { txSignature: signature, actualOutput: 0n, outcome: "not-executed" };
    for (;;) {
      try {
        const settled = await settledFrom();
        if (settled) return settled;
        const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
        // A failure seen only at `processed` may be on a fork that loses, while
        // the same signature succeeds on the one that wins. Believe a failure
        // only once the cluster has voted on it.
        const voted = status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized";
        if (status?.err && voted) return notExecuted;
        if (!status) {
          // "Expired and absent" is only a proof if one view of the chain says
          // all of it. Behind a pooled RPC a lagging node can report no status
          // and no record while a fresh one reports the height — so the height
          // is read with its slot, and the record and the status are then
          // demanded from a node that has reached that slot.
          const epoch = await connection.getEpochInfo("confirmed");
          if ((epoch.blockHeight ?? 0) > lastValidBlockHeight) {
            const late = await fetchIntentRecord(connection, record, { minContextSlot: epoch.absoluteSlot });
            if (late) return { txSignature: signature, actualOutput: late.actualOutput, outcome: "settled" };
            const again = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
            if (again.context.slot >= epoch.absoluteSlot && !again.value[0]) return notExecuted;
          }
        }
      } catch {
        // Still unreachable, or a node that has not caught up; keep asking.
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, this.cfg.resolvePollMs ?? 3_000));
    }
  }
}

/**
 * The stub router as a venue.
 *
 * It is a real program deployed on devnet, not a mock in this process — but it
 * is a *test* venue: it fills at the quoted price because a test fixture has no
 * liquidity of its own, and its pool side needs a signature this process holds.
 * A real aggregator needs neither, which is why `signers` is optional and why
 * this builder is the one thing here that a mainnet deployment must not use.
 */
export class StubRouteBuilder implements SolanaRouteBuilder {
  readonly venue: VenueId;

  constructor(
    private readonly cfg: {
      venue: VenueId;
      programId: PublicKey;
      vaultAuthority: PublicKey;
      vault: PublicKey;
      poolInput: PublicKey;
      poolOutput: PublicKey;
      poolAuthority: Keypair;
      usdcMint: PublicKey;
      stockMint: PublicKey;
      stockAccount: PublicKey;
      inputTokenProgram: PublicKey;
      outputTokenProgram: PublicKey;
    },
  ) {
    this.venue = cfg.venue;
  }

  async build({ quote, amountIn, minOutput }: RouteRequest): Promise<SolanaVenueRoute> {
    // Fill at what the quote promised; never below the floor the intent
    // committed to, or the governor would refuse our own honest route.
    const outputGiven = quote.outAmount > minOutput ? quote.outAmount : minOutput;
    return {
      programId: this.cfg.programId,
      accounts: stubSwapAccounts({
        vaultAuthority: this.cfg.vaultAuthority,
        poolAuthority: this.cfg.poolAuthority.publicKey,
        vault: this.cfg.vault,
        poolInput: this.cfg.poolInput,
        poolOutput: this.cfg.poolOutput,
        destination: this.cfg.stockAccount,
        inputMint: this.cfg.usdcMint,
        outputMint: this.cfg.stockMint,
        inputTokenProgram: this.cfg.inputTokenProgram,
        outputTokenProgram: this.cfg.outputTokenProgram,
      }),
      data: stubSwapData(amountIn, outputGiven),
      signers: [this.cfg.poolAuthority],
    };
  }
}
