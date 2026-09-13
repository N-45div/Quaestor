import { ethers } from "ethers";
import { validateJupiterQuote } from "./jupiter";
import {
  StockRefusal,
  type JupiterQuote,
  type StockExecutionResult,
  type StockInstrument,
  type StockPolicy,
  type StockReceipt,
  type StockTradeIntent,
} from "./types";

export interface StockChainExecutor {
  /**
   * Execute the already-validated transaction. A production implementation
   * submits a Jupiter-built transaction from the vault authority and returns
   * the observed output balance and signature.
   */
  execute(intent: StockTradeIntent, quote: JupiterQuote): Promise<StockExecutionResult>;
}

export interface StockSettlementLookup {
  /** Return a confirmed result, or null while the transaction is unresolved. */
  resolve(intent: StockTradeIntent): Promise<StockExecutionResult | null>;
}

export interface StockGovernorConfig {
  owner: string;
  operator: string;
  usdcMint: string;
  instruments: StockInstrument[];
  policy: StockPolicy;
  now?: () => number;
}

type IntentState = {
  status: "pending" | "settled" | "failed";
  intent: StockTradeIntent;
  epoch: number;
  amount: bigint;
};

/**
 * Policy-first Solana stock governor.
 *
 * It models the on-chain state we will move into an Anchor program: owner and
 * operator separation, a USDC vault balance, approved stock mints, epoch and
 * per-trade caps, pause, replay protection and receipts. The executor is
 * deliberately injected so tests can prove all policy behavior without
 * pretending a local callback is a mainnet transaction.
 */
export class StockGovernor {
  private readonly now: () => number;
  private readonly policy: StockPolicy;
  private readonly instruments = new Map<string, StockInstrument>();
  private readonly spent = new Map<number, bigint>();
  private readonly receipts = new Map<string, StockReceipt>();
  private readonly reserved = new Map<number, bigint>();
  private readonly intents = new Map<string, IntentState>();
  private usdcBalance: bigint;
  private reservedBalance = 0n;
  private suspended = false;

  constructor(private readonly cfg: StockGovernorConfig) {
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
    this.policy = {
      epochCapUsdc: cfg.policy.epochCapUsdc,
      perTradeCapUsdc: cfg.policy.perTradeCapUsdc,
      epochLengthSeconds: cfg.policy.epochLengthSeconds,
      approvedMints: new Set(cfg.policy.approvedMints),
    };
    this.usdcBalance = 0n;
    for (const instrument of cfg.instruments) this.instruments.set(instrument.mint, Object.freeze({ ...instrument }));
  }

  depositUsdc(caller: string, amount: bigint): void {
    this.requireOwner(caller);
    if (amount <= 0n) throw new Error("deposit amount must be positive");
    this.usdcBalance += amount;
  }

  withdrawUsdc(caller: string, amount: bigint): void {
    this.requireOwner(caller);
    const available = this.usdcBalance - this.reservedBalance;
    if (amount <= 0n || amount > available) throw new Error("invalid withdrawal amount");
    this.usdcBalance -= amount;
  }

  suspend(caller: string): void {
    this.requireOwner(caller);
    this.suspended = true;
  }

  resume(caller: string): void {
    this.requireOwner(caller);
    this.suspended = false;
  }

  status(): {
    owner: string;
    operator: string;
    usdcBalance: bigint;
    reservedBalance: bigint;
    suspended: boolean;
    epoch: number;
    spent: bigint;
    pending: bigint;
  } {
    const epoch = this.epoch();
    return {
      owner: this.cfg.owner,
      operator: this.cfg.operator,
      usdcBalance: this.usdcBalance,
      reservedBalance: this.reservedBalance,
      suspended: this.suspended,
      epoch,
      spent: this.spent.get(epoch) ?? 0n,
      pending: this.reserved.get(epoch) ?? 0n,
    };
  }

  instrument(mint: string): StockInstrument | undefined {
    const instrument = this.instruments.get(mint);
    return instrument ? { ...instrument } : undefined;
  }

  receipt(intentId: string): StockReceipt | undefined {
    return this.receipts.get(intentId);
  }

  intentStatus(intentId: string): IntentState["status"] | undefined {
    return this.intents.get(intentId)?.status;
  }

  async execute(intent: StockTradeIntent, quote: JupiterQuote, executor: StockChainExecutor): Promise<StockReceipt> {
    const instrument = this.requireInstrument(intent.instrumentMint);
    // Copy every field used after the first await. A caller must not be able
    // to mutate the authorization while a transaction is in flight.
    const snapshot: StockTradeIntent = Object.freeze({ ...intent });
    const quoteSnapshot: JupiterQuote = Object.freeze({ ...quote });
    this.validateIntent(snapshot, instrument);
    validateJupiterQuote(snapshot, instrument, quoteSnapshot, this.now());

    // Reserve synchronously before handing control to the executor. JavaScript
    // cannot interleave this section, so concurrent calls see each other's
    // reservations and cannot oversubscribe the epoch or vault.
    const epoch = this.epoch();
    const spentAfter = (this.spent.get(epoch) ?? 0n) + (this.reserved.get(epoch) ?? 0n) + snapshot.amountInUsdc;
    if (spentAfter > this.policy.epochCapUsdc) {
      throw new StockRefusal("EPOCH_CAP_EXCEEDED", "trade exceeds the epoch cap");
    }
    const available = this.usdcBalance - this.reservedBalance;
    if (snapshot.amountInUsdc > available) throw new Error("insufficient USDC vault balance");
    this.reserved.set(epoch, (this.reserved.get(epoch) ?? 0n) + snapshot.amountInUsdc);
    this.reservedBalance += snapshot.amountInUsdc;
    this.intents.set(snapshot.intentId, { status: "pending", intent: snapshot, epoch, amount: snapshot.amountInUsdc });

    // The chain executor is called before accounting is committed. If it
    // throws, the reservation remains pending: a timeout cannot safely be
    // retried because the remote chain may already have accepted the trade.
    let result: StockExecutionResult;
    try {
      result = await executor.execute(snapshot, quoteSnapshot);
    } catch (error) {
      throw error;
    }
    if (result.actualOutput < snapshot.minOutput) {
      this.releaseReservation(snapshot.intentId);
      throw new StockRefusal("SLIPPAGE_EXCEEDED", "settled output is below the intent minimum");
    }

    return this.settlePending(snapshot.intentId, result);
  }

  /**
   * Reconcile a timeout through a chain-aware lookup. A null result leaves the
   * reservation pending; callers must never retry the intent just because a
   * submission request timed out.
   */
  async reconcilePending(caller: string, intentId: string, lookup: StockSettlementLookup): Promise<StockReceipt | null> {
    this.requireOwner(caller);
    const pending = this.intents.get(intentId);
    if (!pending || pending.status !== "pending") {
      throw new StockRefusal("INTENT_IN_FLIGHT", "intent is not pending reconciliation");
    }
    const result = await lookup.resolve(pending.intent);
    if (!result) return null;
    if (result.actualOutput < pending.intent.minOutput) {
      this.releaseReservation(intentId);
      throw new StockRefusal("SLIPPAGE_EXCEEDED", "settled output is below the intent minimum");
    }
    return this.settlePending(intentId, result);
  }

  private settlePending(intentId: string, result: StockExecutionResult): StockReceipt {
    const pending = this.intents.get(intentId);
    if (!pending || pending.status !== "pending") {
      throw new Error("intent reservation disappeared before settlement");
    }

    const settledSpent = (this.spent.get(pending.epoch) ?? 0n) + pending.amount;
    this.spent.set(pending.epoch, settledSpent);
    this.reserved.set(pending.epoch, (this.reserved.get(pending.epoch) ?? 0n) - pending.amount);
    this.reservedBalance -= pending.amount;
    this.usdcBalance -= pending.amount;
    pending.status = "settled";
    const receipt: StockReceipt = Object.freeze({
      intentId: pending.intent.intentId,
      agentId: pending.intent.agentId,
      instrumentMint: pending.intent.instrumentMint,
      inputAmount: pending.intent.amountInUsdc,
      outputAmount: result.actualOutput,
      decisionHash: pending.intent.decisionHash,
      txSignature: result.txSignature,
      epoch: pending.epoch,
      spentAfter: settledSpent,
      committedAt: new Date(this.now() * 1000).toISOString(),
    });
    this.receipts.set(pending.intent.intentId, receipt);
    return receipt;
  }

  private validateIntent(intent: StockTradeIntent, instrument: StockInstrument): void {
    if (this.suspended) throw new StockRefusal("SUSPENDED", "stock agent is suspended");
    const previous = this.intents.get(intent.intentId);
    if (previous?.status === "pending") throw new StockRefusal("INTENT_IN_FLIGHT", "intent is already executing");
    if (previous?.status === "failed") throw new StockRefusal("INTENT_FAILED", "intent failed and requires reconciliation");
    if (this.receipts.has(intent.intentId)) throw new StockRefusal("DUPLICATE_INTENT", "intent was already executed");
    if (intent.operator !== this.cfg.operator) throw new StockRefusal("WRONG_OPERATOR", "operator is not authorized");
    if (!instrument.enabled) throw new StockRefusal("UNKNOWN_INSTRUMENT", "instrument is disabled");
    if (!this.policy.approvedMints.has(instrument.mint)) {
      throw new StockRefusal("UNAPPROVED_INSTRUMENT", "instrument is not approved by the owner");
    }
    if (intent.inputMint !== this.cfg.usdcMint) throw new StockRefusal("WRONG_INPUT_MINT", "only the configured USDC mint is accepted");
    if (intent.amountInUsdc <= 0n) throw new StockRefusal("INVALID_AMOUNT", "trade amount must be positive");
    if (intent.amountInUsdc > this.policy.perTradeCapUsdc) {
      throw new StockRefusal("PER_TRADE_CAP_EXCEEDED", "trade exceeds the per-trade cap");
    }
    if (hashCanonicalIntent(intent) !== intent.decisionHash) {
      throw new StockRefusal("DECISION_HASH_MISMATCH", "decision hash does not match the trade intent");
    }
  }

  private releaseReservation(intentId: string): void {
    const pending = this.intents.get(intentId);
    if (!pending || pending.status !== "pending") return;
    pending.status = "failed";
    this.reserved.set(pending.epoch, (this.reserved.get(pending.epoch) ?? 0n) - pending.amount);
    this.reservedBalance -= pending.amount;
  }

  private requireInstrument(mint: string): StockInstrument {
    const instrument = this.instruments.get(mint);
    if (!instrument) throw new StockRefusal("UNKNOWN_INSTRUMENT", "instrument is not registered");
    return instrument;
  }

  private epoch(): number {
    return Math.floor(this.now() / this.policy.epochLengthSeconds);
  }

  private requireOwner(caller: string): void {
    if (caller !== this.cfg.owner) throw new Error("owner authorization required");
  }
}

/** Stable decision identity for the receipt commitment. */
export function decisionHash(input: Omit<StockTradeIntent, "decisionHash">): string {
  return hashCanonicalIntent(input);
}

function hashCanonicalIntent(input: Omit<StockTradeIntent, "decisionHash"> | StockTradeIntent): string {
  const canonical = canonicalIntent(input);
  return ethers.keccak256(
    ethers.toUtf8Bytes(
      JSON.stringify(canonical),
    ),
  );
}

function canonicalIntent(input: Omit<StockTradeIntent, "decisionHash"> | StockTradeIntent) {
  return {
    intentId: input.intentId,
    agentId: input.agentId,
    operator: input.operator,
    instrumentMint: input.instrumentMint,
    inputMint: input.inputMint,
    amountInUsdc: input.amountInUsdc.toString(),
    minOutput: input.minOutput.toString(),
    quoteId: input.quoteId,
    quoteExpiresAt: input.quoteExpiresAt,
  };
}
