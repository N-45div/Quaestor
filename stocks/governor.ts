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

export interface StockGovernorConfig {
  owner: string;
  operator: string;
  usdcMint: string;
  instruments: StockInstrument[];
  policy: StockPolicy;
  now?: () => number;
}

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
  private readonly instruments = new Map<string, StockInstrument>();
  private readonly spent = new Map<number, bigint>();
  private readonly receipts = new Map<string, StockReceipt>();
  private usdcBalance: bigint;
  private suspended = false;

  constructor(private readonly cfg: StockGovernorConfig) {
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
    this.usdcBalance = 0n;
    for (const instrument of cfg.instruments) this.instruments.set(instrument.mint, instrument);
  }

  depositUsdc(caller: string, amount: bigint): void {
    this.requireOwner(caller);
    if (amount <= 0n) throw new Error("deposit amount must be positive");
    this.usdcBalance += amount;
  }

  withdrawUsdc(caller: string, amount: bigint): void {
    this.requireOwner(caller);
    if (amount <= 0n || amount > this.usdcBalance) throw new Error("invalid withdrawal amount");
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

  status(): { owner: string; operator: string; usdcBalance: bigint; suspended: boolean; epoch: number; spent: bigint } {
    const epoch = this.epoch();
    return {
      owner: this.cfg.owner,
      operator: this.cfg.operator,
      usdcBalance: this.usdcBalance,
      suspended: this.suspended,
      epoch,
      spent: this.spent.get(epoch) ?? 0n,
    };
  }

  instrument(mint: string): StockInstrument | undefined {
    return this.instruments.get(mint);
  }

  receipt(intentId: string): StockReceipt | undefined {
    return this.receipts.get(intentId);
  }

  async execute(intent: StockTradeIntent, quote: JupiterQuote, executor: StockChainExecutor): Promise<StockReceipt> {
    const instrument = this.requireInstrument(intent.instrumentMint);
    this.validateIntent(intent, instrument);
    validateJupiterQuote(intent, instrument, quote, this.now());

    // The chain executor is called before accounting is committed. If it
    // throws, the governor's logical state remains unchanged.
    const result = await executor.execute(intent, quote);
    if (result.actualOutput < intent.minOutput) {
      throw new StockRefusal("SLIPPAGE_EXCEEDED", "settled output is below the intent minimum");
    }

    const epoch = this.epoch();
    const spentBefore = this.spent.get(epoch) ?? 0n;
    const spentAfter = spentBefore + intent.amountInUsdc;
    this.spent.set(epoch, spentAfter);
    this.usdcBalance -= intent.amountInUsdc;
    const receipt: StockReceipt = {
      intentId: intent.intentId,
      agentId: intent.agentId,
      instrumentMint: intent.instrumentMint,
      inputAmount: intent.amountInUsdc,
      outputAmount: result.actualOutput,
      decisionHash: intent.decisionHash,
      txSignature: result.txSignature,
      epoch,
      spentAfter,
      committedAt: new Date(this.now() * 1000).toISOString(),
    };
    this.receipts.set(intent.intentId, receipt);
    return receipt;
  }

  private validateIntent(intent: StockTradeIntent, instrument: StockInstrument): void {
    if (this.suspended) throw new StockRefusal("SUSPENDED", "stock agent is suspended");
    if (this.receipts.has(intent.intentId)) throw new StockRefusal("DUPLICATE_INTENT", "intent was already executed");
    if (intent.operator !== this.cfg.operator) throw new StockRefusal("WRONG_OPERATOR", "operator is not authorized");
    if (!instrument.enabled) throw new StockRefusal("UNKNOWN_INSTRUMENT", "instrument is disabled");
    if (!this.cfg.policy.approvedMints.has(instrument.mint)) {
      throw new StockRefusal("UNAPPROVED_INSTRUMENT", "instrument is not approved by the owner");
    }
    if (intent.inputMint !== this.cfg.usdcMint) throw new StockRefusal("WRONG_INPUT_MINT", "only the configured USDC mint is accepted");
    if (intent.amountInUsdc <= 0n) throw new StockRefusal("INVALID_AMOUNT", "trade amount must be positive");
    if (intent.amountInUsdc > this.cfg.policy.perTradeCapUsdc) {
      throw new StockRefusal("PER_TRADE_CAP_EXCEEDED", "trade exceeds the per-trade cap");
    }
    const spentAfter = (this.spent.get(this.epoch()) ?? 0n) + intent.amountInUsdc;
    if (spentAfter > this.cfg.policy.epochCapUsdc) {
      throw new StockRefusal("EPOCH_CAP_EXCEEDED", "trade exceeds the epoch cap");
    }
    if (intent.amountInUsdc > this.usdcBalance) throw new Error("insufficient USDC vault balance");
  }

  private requireInstrument(mint: string): StockInstrument {
    const instrument = this.instruments.get(mint);
    if (!instrument) throw new StockRefusal("UNKNOWN_INSTRUMENT", "instrument is not registered");
    return instrument;
  }

  private epoch(): number {
    return Math.floor(this.now() / this.cfg.policy.epochLengthSeconds);
  }

  private requireOwner(caller: string): void {
    if (caller !== this.cfg.owner) throw new Error("owner authorization required");
  }
}

/** Stable decision identity for the receipt commitment. */
export function decisionHash(input: Omit<StockTradeIntent, "decisionHash">): string {
  return ethers.keccak256(
    ethers.toUtf8Bytes(
      JSON.stringify({
        ...input,
        amountInUsdc: input.amountInUsdc.toString(),
        minOutput: input.minOutput.toString(),
      }),
    ),
  );
}
