import type { VenueId } from "./venues";
/**
 * Common types for the Solana stocks execution arm.
 *
 * Amounts are integer base units represented as strings at API boundaries. We
 * never use floating point for policy or settlement decisions.
 */

export interface StockInstrument {
  /** Issuer-qualified symbol, e.g. AAPLx. */
  symbol: string;
  issuer: string;
  mint: string;
  usdcMint: string;
  decimals: number;
  enabled: boolean;
  network?: "solana-mainnet" | "solana-devnet";
  underlyingSymbol?: string;
  isin?: string;
  tokenProgram?: string;
  transferRules?: readonly string[];
  sourceUrl?: string;
  jurisdictionNotice?: string;
  legalUrl?: string;
  name?: string;
  provider?: "xstocks" | "prestocks" | "tessera";
  assetClass?: "public-equity-exposure" | "private-company-exposure";
  executionStatus?: "enabled" | "discovery-only";
  /**
   * Venues observed able to fill this mint. Empty means listed but not
   * tradeable, which is the honest state for most of a private-markets
   * catalogue rather than an error.
   */
  tradableVenues?: readonly VenueId[];
  /**
   * Venues that could not be asked when this catalogue was built — a timeout, a
   * rate limit, an outage. An empty `tradableVenues` with entries here means
   * "unknown", not "nothing will fill it"; an agent that cannot tell those
   * apart will read a busy API as an illiquid market.
   */
  routabilityUnknownVenues?: readonly VenueId[];
  description?: string;
  imageUrl?: string;
  externalUrl?: string;
  rightsNotice?: string;
  lifecycleNotice?: string;
  referenceData?: {
    observedAt: string;
    markPriceUsd: string;
    tokenPriceUsd: string;
    premiumBps: number;
    markValuationUsd: string;
    impliedValuationUsd: string;
    providerReportedSupply: string;
    onchainMintSupply: string;
  };
}

export interface StockInstrumentCatalogSource {
  readonly provider: string;
  instruments(): Promise<StockInstrument[]>;
}

export interface StockInstrumentCatalogSourceStatus {
  provider: string;
  status: "ok" | "unavailable";
  count: number;
  error?: string;
}

export interface StockInstrumentCatalog {
  observed_at: string;
  instruments: StockInstrument[];
  sources: StockInstrumentCatalogSourceStatus[];
}

export interface StockPolicy {
  epochCapUsdc: bigint;
  perTradeCapUsdc: bigint;
  epochLengthSeconds: number;
  approvedMints: Set<string>;
  /**
   * Venues the owner allows, mirroring the on-chain `ApprovedRouter` set. A
   * config that omits it gets Jupiter alone: the safe reading of "unspecified"
   * is the one venue that existed before there was a choice, not all of them.
   */
  approvedVenues: Set<VenueId>;
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
  intentExpiresAt: number;
  /** Hash of the human-readable/model decision record stored off-chain. */
  decisionRecordHash: string;
  /** Canonical authorization hash over every field above. */
  decisionHash: string;
}

export interface JupiterQuote {
  quoteId: string;
  /** Which venue produced this quote. Absent means Jupiter, for older callers. */
  venue?: VenueId;
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  /** Minimum output encoded by the route after slippage. */
  minimumOutput?: bigint;
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
  decisionRecordHash: string;
  txSignature: string;
  epoch: number;
  spentAfter: bigint;
  committedAt: string;
}

export interface StockPolicyPreview {
  allowed: boolean;
  refusalCode?: StockRefusalCode;
  reason?: string;
  epoch: number;
  perTradeCapUsdc: bigint;
  epochCapUsdc: bigint;
  spentUsdc: bigint;
  reservedUsdc: bigint;
  availableVaultUsdc: bigint;
}

export type StockRefusalCode =
  | "SUSPENDED"
  | "UNKNOWN_INSTRUMENT"
  | "UNAPPROVED_INSTRUMENT"
  | "UNAPPROVED_VENUE"
  | "WRONG_INPUT_MINT"
  | "WRONG_OPERATOR"
  | "INVALID_AMOUNT"
  | "PER_TRADE_CAP_EXCEEDED"
  | "EPOCH_CAP_EXCEEDED"
  | "QUOTE_EXPIRED"
  | "INTENT_EXPIRED"
  | "QUOTE_MISMATCH"
  | "SLIPPAGE_EXCEEDED"
  | "DUPLICATE_INTENT"
  | "INTENT_IN_FLIGHT"
  | "INTENT_FAILED"
  | "DECISION_HASH_MISMATCH"
  | "DECISION_RECORD_HASH_INVALID"
  | "INVALID_EXECUTION_RESULT"
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
