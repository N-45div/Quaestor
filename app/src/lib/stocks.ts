/**
 * Client for the stocks lane on the Quaestor hub.
 *
 * Kept apart from `state.tsx`, which reads EVM contracts through viem. This
 * lane is plain HTTP against the hub and has no chain client of its own, so
 * mixing them into one store would make every stocks view wait on a wallet it
 * does not need.
 */

/** Where the hub lives. Defaults to a local one, which is how this is demoed. */
export const stocksBase = (): string =>
  (import.meta.env.VITE_STOCKS_API as string | undefined)?.replace(/\/$/, "")
  ?? "http://127.0.0.1:8402";

export interface VenueView {
  id: string;
  label: string;
  program_id: string;
  kind: string;
}

export interface InstrumentView {
  symbol: string;
  name?: string;
  issuer: string;
  mint: string;
  decimals: number;
  enabled: boolean;
  provider?: "xstocks" | "prestocks";
  assetClass?: "public-equity-exposure" | "private-company-exposure";
  executionStatus?: "enabled" | "discovery-only";
  underlyingSymbol?: string;
  tokenProgram?: string;
  transferRules?: string[];
  /** Venues observed able to fill this mint. Evidence, never permission. */
  tradableVenues?: string[];
  /** Venues that could not be asked — unknown, which is not the same as no. */
  routabilityUnknownVenues?: string[];
  externalUrl?: string;
  rightsNotice?: string;
  /** What ends this instrument's market: a curve graduates, a pre-IPO token converts. */
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

export interface CatalogSourceStatus {
  provider: string;
  status: "ok" | "unavailable";
  count: number;
  error?: string;
}

export interface CatalogView {
  observed_at: string;
  instruments: InstrumentView[];
  sources: CatalogSourceStatus[];
}

export interface DiscoveryView {
  version: string;
  network: string;
  execution: "live" | "simulation" | "disabled";
  endpoints: Record<string, string>;
  limits?: LimitsView;
  onchain?: OnchainView;
}

async function get<T>(base: string, path: string, timeoutMs = 180_000): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()) as T;
}

export const fetchDiscovery = (base: string) => get<DiscoveryView>(base, "/v1/stocks", 15_000);

export const fetchVenues = (base: string) =>
  get<{ venues: VenueView[] }>(base, "/v1/stocks/venues", 15_000).then((body) => body.venues);

/** A bonding curve the hub launched, as its issuer would watch it. */
export interface CurveView {
  venue: string;
  pool: string;
  instrument_mint: string;
  symbol: string;
  anchored_to_usd: number;
  band_bps: number;
  opening_price_usd: number;
  graduation_price_usd: number;
  graduation_usdc: number;
  observed_at?: string;
  graduated?: boolean;
  pool_price_usd?: number;
  progress?: number;
  raised_usdc?: number;
  reference_price_usd?: number;
  health?: "tracking" | "reference-above-range" | "reference-below-range" | "graduated";
  premium_bps?: number;
  reference_drift_bps?: number;
  range_position?: number;
  summary: string;
}

export const fetchCurves = (base: string) =>
  get<{ curves: CurveView[] }>(base, "/v1/stocks/curves", 15_000).then((body) => body.curves);

/** Slow on purpose: building it probes every mint against every venue. */
export const fetchCatalog = (base: string) => get<CatalogView>(base, "/v1/stocks/instruments");

/** Basis points as a signed percentage, e.g. -2196 -> "-21.96%". */
export const premiumPercent = (bps: number): string =>
  `${bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;

export const shortMint = (mint: string): string =>
  mint.length > 12 ? `${mint.slice(0, 5)}…${mint.slice(-4)}` : mint;

/**
 * What a row can tell you about execution, in the order that matters.
 *
 * A venue that could not be asked is reported as unknown rather than folded
 * into "no route", because those are different facts and an agent that cannot
 * tell them apart reads a busy API as an illiquid market.
 */
export type RoutingState = "tradeable" | "routable" | "unknown" | "no-route" | "unprobed";

export function routingState(instrument: InstrumentView): RoutingState {
  // An absent list means nobody asked. An empty list means somebody asked and
  // the answer was no. Collapsing the two reports the most liquid names in the
  // catalogue as having no route.
  if (instrument.tradableVenues === undefined) return "unprobed";
  if (instrument.tradableVenues.length > 0) return instrument.enabled ? "tradeable" : "routable";
  if ((instrument.routabilityUnknownVenues ?? []).length > 0) return "unknown";
  return "no-route";
}

export const ROUTING_COPY: Record<RoutingState, { label: string; detail: string }> = {
  tradeable: {
    label: "Tradeable",
    detail: "A venue will fill it and the owner has approved the mint.",
  },
  routable: {
    label: "Routable",
    detail: "A venue will fill it, but the owner has not approved the mint, so no agent can buy it.",
  },
  unknown: {
    label: "Unknown",
    detail: "The venue could not be asked — a timeout or a rate limit. Not the same as no route.",
  },
  "no-route": {
    label: "No route",
    detail: "Every venue was asked and none will fill it.",
  },
  unprobed: {
    label: "Not measured",
    detail: "No venue was asked about this mint, which is not the same as no route existing.",
  },
};

// ------------------------------------------------------------ live prices

export interface PriceBucketView {
  t: number;
  tokenized?: number;
  reference?: number;
  premium_bps?: number;
}

export interface PriceSideView {
  source: string;
  last: number;
  first: number;
  change_pct: number;
  high: number;
  low: number;
  range_pct: number;
  points: number;
  last_update_age_s: number;
}

export interface PriceSummaryView {
  instrument: { symbol: string; mint: string; underlying?: string };
  window_seconds: number;
  generated_at: string;
  tokenized: PriceSideView | null;
  reference: PriceSideView | null;
  premium: {
    now_bps: number;
    start_bps: number;
    mean_bps: number;
    min_bps: number;
    max_bps: number;
    trend: "widening" | "narrowing" | "stable";
  } | null;
  session: { us_equity: string; basis: string };
  sparkline: { tokenized: string; reference: string; premium: string };
  narrative: string;
  series: PriceBucketView[];
}

export const PRICE_WINDOWS = ["15m", "1h", "6h", "24h"] as const;
export type PriceWindow = (typeof PRICE_WINDOWS)[number];

export const fetchPrices = (base: string, mint: string, window: PriceWindow) =>
  get<PriceSummaryView>(base, `/v1/stocks/prices/${encodeURIComponent(mint)}?window=${window}`, 20_000);

// ------------------------------------------------------------ the price gate

export interface MarketObservationView {
  side: "tokenized" | "reference";
  source: string;
  price: number;
  age_seconds: number;
}

export interface SideConsensusView {
  price: number;
  sources: string[];
  spread_bps: number;
  age_seconds: number;
}

export interface QuoteEvidenceView {
  floor_price_usd: number;
  expected_price_usd: number;
  benchmark_price_usd: number;
  benchmark_side: "tokenized" | "reference";
  deviation_bps: number;
  ui_multiplier: number;
}

export interface MarketAssessmentView {
  provider: string;
  instrument_mint: string;
  observed_at: string;
  session: string;
  premium_bps?: number;
  allowed: boolean;
  refusal?: { code: string; message: string };
  /** Which of the owner's policies judged this instrument; "default" unless it has one for its kind. */
  policy_scope?: string;
  policy: {
    max_price_age_seconds: number;
    required_sides: string[];
    max_source_disagreement_bps: number;
    max_absolute_premium_bps: number;
    max_absolute_premium_bps_after_hours: number;
    max_quote_deviation_bps: number;
  };
  observations: MarketObservationView[];
  consensus: { tokenized?: SideConsensusView; reference?: SideConsensusView };
  quote?: QuoteEvidenceView;
  evidence_hash: string;
}

export const fetchMarket = (base: string, mint: string) =>
  get<MarketAssessmentView>(base, `/v1/stocks/markets/${encodeURIComponent(mint)}`, 15_000);

/**
 * Ask the gate about a quote the page describes. Free for what is traded here,
 * because a governed quote already carries the same verdict.
 */
export async function checkQuote(
  base: string,
  body: { instrument_mint: string; usdc_in: string; tokens_out: string; min_tokens_out: string },
): Promise<MarketAssessmentView> {
  const response = await fetch(`${base}/v1/stocks/quote-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 429) throw new Error("the hub is rate-limiting this page; wait a moment");
  if (!response.ok) throw new Error(`quote check returned ${response.status}`);
  return (await response.json()) as MarketAssessmentView;
}

// ---------------------------------------------------- the owner's policy

export interface LimitsView {
  per_trade_cap_usdc: string;
  epoch_cap_usdc: string;
  epoch_length_seconds: number;
  min_trade_usdc: string;
  max_executions_per_day: number;
  approved_venues: string[];
}

export interface OnchainView {
  cluster: "devnet" | "mainnet-beta";
  program: string;
  governor: string;
  vault: string;
  owner: string;
  operator: string;
  operator_custody?: "local-keypair" | "dynamic-mpc";
}

export interface PortfolioView {
  agent_id: string;
  network: string;
  usdc: { balance: string; reserved: string; available: string };
  policy: { suspended: boolean; epoch: number; spent_usdc: string; pending_usdc: string };
  holdings: Array<{ mint: string; symbol: string; amount: string }>;
}

/** The agent this deployment governs. One hub, one agent, until owners can register their own. */
export const stocksAgentId = (): string =>
  (import.meta.env.VITE_STOCKS_AGENT_ID as string | undefined) ?? "solana-agent-1";

export const fetchPortfolio = (base: string, agentId: string) =>
  get<PortfolioView>(base, `/v1/stocks/portfolio?agent_id=${encodeURIComponent(agentId)}`, 15_000);

/** Base units of USDC (6 decimals) as dollars. */
export const usdc = (baseUnits: string | bigint | undefined): number => Number(baseUnits ?? 0) / 1_000_000;

export const solanaExplorer = (kind: "address" | "tx", id: string, cluster: string): string =>
  `https://explorer.solana.com/${kind}/${id}${cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`}`;

// ------------------------------------------------------------- paid tools

export interface IntelIndexView {
  about: string;
  instruments: Array<{ symbol: string; mint: string; underlying?: string; network?: string; tradeable_here: boolean }>;
  tools: Array<{ id: string; method: string; path: string; priceUsd: string; price: string; summary: string }>;
  pay_with: { solana_usdc: string; base_usdc: string };
}

export const fetchIntel = (base: string) => get<IntelIndexView>(base, "/v1/intel", 15_000);
