/**
 * Common types for the Solana stocks execution arm.
 *
 * Amounts are integer base units represented as strings at API boundaries. We
 * never use floating point for policy or settlement decisions.
 */

export interface StockInstrument {
  /** Issuer-qualified symbol, e.g. AAPL.US. */
  symbol: string;
  issuer: string;
  mint: string;
  usdcMint: string;
  decimals: number;
  enabled: boolean;
}

export interface StockPolicy {
  epochCapUsdc: bigint;
  perTradeCapUsdc: bigint;
  epochLengthSeconds: number;
  approvedMints: Set<string>;
}

export interface StockTradeIntent {
  intentId: string;
  agentId: string;
  operator: string;
  instrumentMint: string;
  inputMint: string;
  amountInUsdc: bigint;
  minOutput: bigint;
  quoteId: string;
  quoteExpiresAt: number;
  decisionHash: string;
}

export interface JupiterQuote {
  quoteId: string;
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  /** Route identifier returned by the quote service. */
  route: string;
  expiresAt: number;
}

export interface StockExecutionResult {
  txSignature: string;
  actualOutput: bigint;
  /** Settled means funds moved; not-executed means the chain confirmed no fill. */
  outcome: "settled" | "not-executed";
}

export interface StockReceipt {
  intentId: string;
  agentId: string;
  instrumentMint: string;
  inputAmount: bigint;
  outputAmount: bigint;
  slippageSatisfied: boolean;
  decisionHash: string;
  txSignature: string;
  epoch: number;
  spentAfter: bigint;
  committedAt: string;
}

export type StockRefusalCode =
  | "SUSPENDED"
  | "UNKNOWN_INSTRUMENT"
  | "UNAPPROVED_INSTRUMENT"
  | "WRONG_INPUT_MINT"
  | "WRONG_OPERATOR"
  | "INVALID_AMOUNT"
  | "PER_TRADE_CAP_EXCEEDED"
  | "EPOCH_CAP_EXCEEDED"
  | "QUOTE_EXPIRED"
  | "QUOTE_MISMATCH"
  | "SLIPPAGE_EXCEEDED"
  | "DUPLICATE_INTENT"
  | "INTENT_IN_FLIGHT"
  | "INTENT_FAILED"
  | "DECISION_HASH_MISMATCH"
  | "EXECUTION_REJECTED"
  | "RECONCILIATION_CONFLICT";

export class StockRefusal extends Error {
  constructor(
    public readonly code: StockRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "StockRefusal";
  }
}
