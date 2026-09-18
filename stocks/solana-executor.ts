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
 *   thrown        the network never gave an answer. The intent stays pending
 *                 for reconciliation, because a submission that timed out may
 *                 still have landed.
 */
import { Connection, Keypair, PublicKey, type AccountMeta } from "@solana/web3.js";
import {
  executeTrade,
  fetchIntentRecord,
  governorPda,
  id32,
  intentPda,
  send,
  stubSwapAccounts,
  stubSwapData,
  TxFailure,
} from "../solana/client";
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
  /** Only the operator may trade, and only inside the owner's caps. */
  operator: Keypair;
  /** Pays fees and the IntentRecord's rent. */
  payer: Keypair;
  instruments: Map<string, SolanaInstrumentAccounts>;
  routes: Map<VenueId, SolanaRouteBuilder>;
  cluster?: "devnet" | "mainnet-beta";
}

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

    const signers = [this.cfg.payer, this.cfg.operator, ...(route.signers ?? [])];
    // Distinct keys only: the payer and operator may be the same wallet, and
    // signing twice with one key is rejected as a duplicate signature.
    const unique = [...new Map(signers.map((s) => [s.publicKey.toBase58(), s])).values()];

    try {
      const signature = await send(this.cfg.connection, [instruction], unique);
      const [record] = intentPda(governorPda(this.cfg.governorOwner)[0], intentId);
      const settled = await fetchIntentRecord(this.cfg.connection, record);
      return {
        txSignature: signature,
        // The program's own measurement of what arrived. Falling back to the
        // quote here would report an expectation as an outcome.
        actualOutput: settled?.actualOutput ?? 0n,
        outcome: "settled",
      };
    } catch (error) {
      if (error instanceof TxFailure) {
        // Confirmed and reverted: the governor refused, on chain, with a
        // signature an agent can go and read.
        return { txSignature: error.signature, actualOutput: 0n, outcome: "not-executed" };
      }
      // No answer from the network. Left to throw so the intent stays pending:
      // a timed-out submission may still be confirmed later.
      throw error;
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
