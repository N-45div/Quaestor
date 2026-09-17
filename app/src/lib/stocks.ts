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
  provider?: "xstocks" | "prestocks" | "tessera";
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
