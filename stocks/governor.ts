import { ethers } from "ethers";
import { validateJupiterQuote } from "./jupiter";
import { DEFAULT_VENUE, type VenueId } from "./venues";
import {
  StockRefusal,
  type JupiterQuote,
  type StockExecutionResult,
  type StockInstrument,
  type StockPolicy,
  type StockPolicyPreview,
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
  /**
   * `approvedVenues` may be omitted; the governor fills in Jupiter. Internally
   * the policy always carries a concrete set, so nothing downstream has to
   * treat "unspecified" as a case.
   */
  policy: Omit<StockPolicy, "approvedVenues"> & { approvedVenues?: Iterable<VenueId> };
  now?: () => number;
}

type IntentState = {
  status: "pending" | "settled" | "failed";
  intent: StockTradeIntent;
  epoch: number;
  amount: bigint;
  terminalResult?: StockExecutionResult;
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
  private readonly owner: string;
  private readonly operator: string;
  private readonly usdcMint: string;
  private readonly now: () => number;
  private readonly policy: StockPolicy;
  private readonly instruments = new Map<string, StockInstrument>();
  private readonly spent = new Map<number, bigint>();
  private readonly receipts = new Map<string, StockReceipt>();
  private readonly reserved = new Map<number, bigint>();
  private readonly intents = new Map<string, IntentState>();
  private readonly holdings = new Map<string, bigint>();
  private usdcBalance: bigint;
  private reservedBalance = 0n;
  private suspended = false;

  constructor(cfg: StockGovernorConfig) {
    this.owner = cfg.owner;
    this.operator = cfg.operator;
    this.usdcMint = cfg.usdcMint;
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
    this.policy = {
      epochCapUsdc: cfg.policy.epochCapUsdc,
      perTradeCapUsdc: cfg.policy.perTradeCapUsdc,
      epochLengthSeconds: cfg.policy.epochLengthSeconds,
      approvedMints: new Set(cfg.policy.approvedMints),
      approvedVenues: new Set(cfg.policy.approvedVenues ?? [DEFAULT_VENUE]),
    };
    this.usdcBalance = 0n;
    for (const instrument of cfg.instruments) this.instruments.set(instrument.mint, Object.freeze({ ...instrument }));
  }

  /**
   * Take the chain's word for the vault, the spend and the positions.
   *
   * The caps are enforced on chain, so a forgetful hub was never unsafe — but
   * it answered wrongly, which is its own kind of failure: a fresh process
   * reported nothing spent and a balance it had been configured with, so a
   * preview promised a trade the program would refuse and a portfolio showed
   * none of what the agent held.
   *
   * Only ever called with nothing in flight. A reservation exists precisely
   * because a trade's outcome is unknown, and overwriting the balance it is
   * held against would lose that claim on the vault; so this refuses rather
   * than corrupting the accounting, and the caller tries again later.
   *
   * A cap is not adopted, it is *tightened*. A deployment may run a smaller cap
   * than the owner put on chain — the hosted hub caps at 5 USDC where the chain
   * allows 500 — and adopting the chain's would quietly widen it. The other
   * direction is a promise this hub cannot keep, so it is taken.
   */
  adoptChainState(state: {
    vaultUsdc: bigint;
    epoch: number;
    spentInEpoch: bigint;
    suspended: boolean;
    holdings: readonly { mint: string; amount: bigint }[];
    epochCapUsdc?: bigint;
    perTradeCapUsdc?: bigint;
  }): { tightened: string[] } {
    for (const intent of this.intents.values()) {
      if (intent.status === "pending") throw new Error("cannot adopt chain state while a trade is in flight");
    }
    this.usdcBalance = state.vaultUsdc;
    this.spent.set(state.epoch, state.spentInEpoch);
    this.suspended = state.suspended;
    this.holdings.clear();
    for (const holding of state.holdings) {
      if (holding.amount > 0n) this.holdings.set(holding.mint, holding.amount);
    }
    const tightened: string[] = [];
    if (state.epochCapUsdc !== undefined && state.epochCapUsdc < this.policy.epochCapUsdc) {
      tightened.push(`epoch cap ${this.policy.epochCapUsdc} -> ${state.epochCapUsdc}`);
      this.policy.epochCapUsdc = state.epochCapUsdc;
    }
    if (state.perTradeCapUsdc !== undefined && state.perTradeCapUsdc < this.policy.perTradeCapUsdc) {
      tightened.push(`per-trade cap ${this.policy.perTradeCapUsdc} -> ${state.perTradeCapUsdc}`);
      this.policy.perTradeCapUsdc = state.perTradeCapUsdc;
    }
    return { tightened };
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
      owner: this.owner,
      operator: this.operator,
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

  portfolio(): { usdcBalance: bigint; reservedUsdc: bigint; holdings: { mint: string; amount: bigint }[] } {
    return {
      usdcBalance: this.usdcBalance,
      reservedUsdc: this.reservedBalance,
      holdings: [...this.holdings.entries()].map(([mint, amount]) => ({ mint, amount })),
    };
  }

  preview(intent: StockTradeIntent, quote: JupiterQuote): StockPolicyPreview {
    const epoch = this.epoch();
    const spent = this.spent.get(epoch) ?? 0n;
    const reserved = this.reserved.get(epoch) ?? 0n;
    const base = {
      epoch,
      perTradeCapUsdc: this.policy.perTradeCapUsdc,
      epochCapUsdc: this.policy.epochCapUsdc,
      spentUsdc: spent,
      reservedUsdc: reserved,
      availableVaultUsdc: this.usdcBalance - this.reservedBalance,
    };
    try {
      const instrument = this.requireInstrument(intent.instrumentMint);
      this.validateIntent(intent, instrument);
      this.requireApprovedVenue(quote);
      validateJupiterQuote(intent, instrument, quote, this.now());
      if (spent + reserved + intent.amountInUsdc > this.policy.epochCapUsdc) {
        throw new StockRefusal("EPOCH_CAP_EXCEEDED", "trade exceeds the epoch cap");
      }
      if (intent.amountInUsdc > base.availableVaultUsdc) {
        throw new StockRefusal("INVALID_AMOUNT", "insufficient USDC vault balance");
      }
      return { allowed: true, ...base };
    } catch (error) {
      if (!(error instanceof StockRefusal)) throw error;
      return { allowed: false, refusalCode: error.code, reason: error.message, ...base };
    }
  }

  /** The owner's limits, for anyone to read. They are policy, not a secret. */
  limits(): { perTradeCapUsdc: bigint; epochCapUsdc: bigint; epochLengthSeconds: number; approvedVenues: VenueId[] } {
    return {
      perTradeCapUsdc: this.policy.perTradeCapUsdc,
      epochCapUsdc: this.policy.epochCapUsdc,
      epochLengthSeconds: this.policy.epochLengthSeconds,
      approvedVenues: [...this.policy.approvedVenues],
    };
  }

  /**
   * Whether the owner allows routing through this venue. Asked before a quote
   * is fetched, not only before a trade: a venue the owner never approved
   * cannot fill anything here, so quoting it spends an upstream call — on the
   * owner's key, for anyone who asks — to produce a quote that can only be
   * refused.
   */
  isVenueApproved(venue: VenueId): boolean {
    return this.policy.approvedVenues.has(venue);
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
    this.requireApprovedVenue(quoteSnapshot);
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
    if (snapshot.amountInUsdc > available) {
      throw new StockRefusal("INVALID_AMOUNT", "insufficient USDC vault balance");
    }
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
    return this.applyExecutionResult(snapshot.intentId, result);
  }

  /**
   * Reconcile a timeout through a chain-aware lookup. A null result leaves the
   * reservation pending; callers must never retry the intent just because a
   * submission request timed out.
   */
  async reconcilePending(caller: string, intentId: string, lookup: StockSettlementLookup): Promise<StockReceipt | null> {
    this.requireOwner(caller);
    const state = this.intents.get(intentId);
    if (state?.status === "settled") return this.receipts.get(intentId) ?? null;
    if (state?.status === "failed") {
      throw new StockRefusal("EXECUTION_REJECTED", "chain confirmed that the trade did not execute");
    }
    if (!state || state.status !== "pending") {
      throw new StockRefusal("INTENT_IN_FLIGHT", "intent is not pending reconciliation");
    }
    const result = await lookup.resolve(state.intent);
    if (!result) return null;
    return this.applyExecutionResult(intentId, result);
  }

  private applyExecutionResult(intentId: string, result: StockExecutionResult): StockReceipt {
    validateExecutionResult(result);
    const state = this.intents.get(intentId);
    if (state?.status === "settled") {
      const existing = this.receipts.get(intentId);
      if (result.outcome === "settled" && existing?.txSignature === result.txSignature && existing.outputAmount === result.actualOutput) {
        return existing;
      }
      throw new StockRefusal("RECONCILIATION_CONFLICT", "conflicting execution outcome for an intent");
    }
    if (state?.status === "failed") {
      const terminal = state.terminalResult;
      if (result.outcome === "not-executed" && terminal?.txSignature === result.txSignature && terminal.actualOutput === result.actualOutput) {
        throw new StockRefusal("EXECUTION_REJECTED", "chain confirmed that the trade did not execute");
      }
      throw new StockRefusal("RECONCILIATION_CONFLICT", "execution evidence arrived after confirmed non-execution");
    }
    if (result.outcome === "not-executed") {
      this.releaseReservation(intentId, Object.freeze({ ...result }));
      throw new StockRefusal(
        "EXECUTION_REJECTED",
        result.txSignature === "not-submitted"
          ? "the trade was never submitted; nothing was spent"
          : `the chain confirmed that the trade did not execute (transaction ${result.txSignature})`,
      );
    }
    return this.settlePending(intentId, result);
  }

  private settlePending(intentId: string, result: StockExecutionResult): StockReceipt {
    const pending = this.intents.get(intentId);
    if (pending?.status === "settled") {
      const existing = this.receipts.get(intentId);
      if (existing && existing.txSignature === result.txSignature && existing.outputAmount === result.actualOutput) {
        return existing;
      }
      throw new StockRefusal("RECONCILIATION_CONFLICT", "conflicting settlement evidence for an intent");
    }
    if (!pending || pending.status !== "pending") {
      throw new Error("intent reservation disappeared before settlement");
    }

    const settledSpent = (this.spent.get(pending.epoch) ?? 0n) + pending.amount;
    this.spent.set(pending.epoch, settledSpent);
    this.reserved.set(pending.epoch, (this.reserved.get(pending.epoch) ?? 0n) - pending.amount);
    this.reservedBalance -= pending.amount;
    this.usdcBalance -= pending.amount;
    pending.status = "settled";
    this.holdings.set(
      pending.intent.instrumentMint,
      (this.holdings.get(pending.intent.instrumentMint) ?? 0n) + result.actualOutput,
    );
    const receipt: StockReceipt = Object.freeze({
      intentId: pending.intent.intentId,
      agentId: pending.intent.agentId,
      instrumentMint: pending.intent.instrumentMint,
      inputAmount: pending.intent.amountInUsdc,
      outputAmount: result.actualOutput,
      slippageSatisfied: result.actualOutput >= pending.intent.minOutput,
      decisionHash: pending.intent.decisionHash,
      decisionRecordHash: pending.intent.decisionRecordHash,
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
    if (previous?.status === "failed") throw new StockRefusal("INTENT_FAILED", "intent already failed; create a new intent");
    if (this.receipts.has(intent.intentId)) throw new StockRefusal("DUPLICATE_INTENT", "intent was already executed");
    if (intent.operator !== this.operator) throw new StockRefusal("WRONG_OPERATOR", "operator is not authorized");
    if (!instrument.enabled) throw new StockRefusal("UNKNOWN_INSTRUMENT", "instrument is disabled");
    if (!this.policy.approvedMints.has(instrument.mint)) {
      throw new StockRefusal("UNAPPROVED_INSTRUMENT", "instrument is not approved by the owner");
    }
    if (intent.inputMint !== this.usdcMint) throw new StockRefusal("WRONG_INPUT_MINT", "only the configured USDC mint is accepted");
    if (intent.amountInUsdc <= 0n) throw new StockRefusal("INVALID_AMOUNT", "trade amount must be positive");
    if (!/^0x[0-9a-fA-F]{64}$/.test(intent.decisionRecordHash)) {
      throw new StockRefusal("DECISION_RECORD_HASH_INVALID", "decision record hash must be 32-byte hex");
    }
    if (intent.intentExpiresAt <= this.now()) {
      throw new StockRefusal("INTENT_EXPIRED", "trade intent has expired");
    }
    if (intent.amountInUsdc > this.policy.perTradeCapUsdc) {
      throw new StockRefusal("PER_TRADE_CAP_EXCEEDED", "trade exceeds the per-trade cap");
    }
    if (hashCanonicalIntent(intent) !== intent.decisionHash) {
      throw new StockRefusal("DECISION_HASH_MISMATCH", "decision hash does not match the trade intent");
    }
  }

  private releaseReservation(intentId: string, result: StockExecutionResult): void {
    const pending = this.intents.get(intentId);
    if (!pending || pending.status !== "pending") return;
    pending.status = "failed";
    pending.terminalResult = result;
    this.reserved.set(pending.epoch, (this.reserved.get(pending.epoch) ?? 0n) - pending.amount);
    this.reservedBalance -= pending.amount;
  }

  /**
   * The off-chain half of the on-chain venue allowlist.
   *
   * The program refuses an unapproved venue by failing to derive its
   * ApprovedRouter PDA, which costs a transaction to discover. Refusing here
   * means an agent is told which venues it may route through before it pays to
   * find out.
   */
  private requireApprovedVenue(quote: JupiterQuote): VenueId {
    const venue = quote.venue ?? DEFAULT_VENUE;
    if (!this.policy.approvedVenues.has(venue)) {
      throw new StockRefusal("UNAPPROVED_VENUE", `venue "${venue}" is not approved by the owner`);
    }
    return venue;
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
    if (caller !== this.owner) throw new Error("owner authorization required");
  }
}

function validateExecutionResult(result: StockExecutionResult): void {
  if (!result || typeof result !== "object") {
    throw new StockRefusal("INVALID_EXECUTION_RESULT", "executor returned an invalid result");
  }
  if (result.outcome !== "settled" && result.outcome !== "not-executed") {
    throw new StockRefusal("INVALID_EXECUTION_RESULT", "executor returned an unknown outcome");
  }
  if (typeof result.txSignature !== "string" || result.txSignature.trim().length === 0) {
    throw new StockRefusal("INVALID_EXECUTION_RESULT", "executor result is missing a transaction signature");
  }
  if (typeof result.actualOutput !== "bigint" || result.actualOutput < 0n) {
    throw new StockRefusal("INVALID_EXECUTION_RESULT", "executor output must be a non-negative bigint");
  }
  if (result.outcome === "not-executed" && result.actualOutput !== 0n) {
    throw new StockRefusal("INVALID_EXECUTION_RESULT", "a non-executed trade cannot report output");
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
    intentExpiresAt: input.intentExpiresAt,
    decisionRecordHash: input.decisionRecordHash,
  };
}
