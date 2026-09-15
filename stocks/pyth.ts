import { createHash } from "node:crypto";
import { z } from "zod";
import type { StockInstrument } from "./types";

const integerSchema = z.union([
  z.string().regex(/^-?\d+$/),
  z.number().int().safe(),
]);

const priceFeedSchema = z.object({
  priceFeedId: z.number().int().positive(),
  price: integerSchema,
  publisherCount: z.number().int().nonnegative(),
  exponent: z.number().int().min(-18).max(18),
  confidence: integerSchema,
  marketSession: z.string().min(1),
  feedUpdateTimestamp: integerSchema,
});

const latestPriceSchema = z.object({
  parsed: z.object({
    timestampUs: integerSchema,
    priceFeeds: z.array(priceFeedSchema),
  }),
  solana: z.object({
    encoding: z.string().min(1),
    data: z.string().min(1),
  }),
}).passthrough();

export interface PythFeedDefinition {
  lazerId: number;
  symbol: string;
  hermesId: string;
}

export interface PythInstrumentFeeds {
  underlying: PythFeedDefinition;
  tokenized: PythFeedDefinition;
}

export interface PythPricePoint {
  feed_id: number;
  symbol: string;
  mantissa: string;
  exponent: number;
  confidence: string;
  confidence_bps: number;
  publisher_count: number;
  market_session: string;
  feed_update_timestamp_us: string;
  age_ms: number;
}

export type StockMarketRefusalCode =
  | "PYTH_PRICE_STALE"
  | "PYTH_PUBLISHERS_LOW"
  | "PYTH_CONFIDENCE_WIDE"
  | "PYTH_PRICE_DISLOCATION";

export interface StockMarketAssessment {
  provider: "pyth-pro";
  instrument_mint: string;
  observed_at: string;
  timestamp_us: string;
  premium_bps: number;
  allowed: boolean;
  refusal?: { code: StockMarketRefusalCode; message: string };
  policy: PythMarketPolicy;
  feeds: {
    underlying: PythPricePoint;
    tokenized: PythPricePoint;
  };
  solana_payload_hash: string;
  evidence_hash: string;
}

export interface PythMarketPolicy {
  max_feed_age_seconds: number;
  max_absolute_premium_bps: number;
  max_confidence_bps: number;
  min_publishers: number;
}

export interface StockMarketGuard {
  assess(instrument: StockInstrument): Promise<StockMarketAssessment>;
  revalidate(assessment: StockMarketAssessment): StockMarketAssessment;
}

export const PYTH_STOCK_FEEDS: Readonly<Record<string, PythInstrumentFeeds>> = Object.freeze({
  XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp: Object.freeze({
    underlying: Object.freeze({
      lazerId: 922,
      symbol: "Equity.US.AAPL/USD",
      hermesId: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
    }),
    tokenized: Object.freeze({
      lazerId: 1792,
      symbol: "Crypto.AAPLX/USD",
      hermesId: "978e6cc68a119ce066aa830017318563a9ed04ec3a0a6439010fc11296a58675",
    }),
  }),
  Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh: Object.freeze({
    underlying: Object.freeze({
      lazerId: 1314,
      symbol: "Equity.US.NVDA/USD",
      hermesId: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
    }),
    tokenized: Object.freeze({
      lazerId: 1833,
      symbol: "Crypto.NVDAX/USD",
      hermesId: "4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f",
    }),
  }),
  XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W: Object.freeze({
    underlying: Object.freeze({
      lazerId: 1398,
      symbol: "Equity.US.SPY/USD",
      hermesId: "19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5",
    }),
    tokenized: Object.freeze({
      lazerId: 1843,
      symbol: "Crypto.SPYX/USD",
      hermesId: "2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14",
    }),
  }),
});

export interface PythProConfig {
  apiKey: string;
  endpoint?: string;
  channel?: "real_time" | "fixed_rate@1ms" | "fixed_rate@50ms" | "fixed_rate@200ms" | "fixed_rate@1000ms";
  fetch?: typeof fetch;
}

/** Fetches signed Pyth Pro data for the equity and its 24/7 tokenized twin. */
export class PythProStockSource {
  constructor(private readonly cfg: PythProConfig) {
    if (!cfg.apiKey.trim()) throw new Error("Pyth Pro API key is required");
  }

  async snapshot(instrument: StockInstrument): Promise<Omit<StockMarketAssessment, "allowed" | "refusal" | "policy">> {
    const definitions = PYTH_STOCK_FEEDS[instrument.mint];
    if (!definitions) throw new Error(`no Pyth feed pair configured for ${instrument.mint}`);
    const response = await (this.cfg.fetch ?? fetch)(`${this.cfg.endpoint ?? "https://pyth-lazer.dourolabs.app"}/v1/latest_price`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        priceFeedIds: [definitions.underlying.lazerId, definitions.tokenized.lazerId],
        properties: ["price", "confidence", "publisherCount", "exponent", "marketSession", "feedUpdateTimestamp"],
        formats: ["solana"],
        channel: this.cfg.channel ?? "fixed_rate@200ms",
        ignoreInvalidFeeds: false,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Pyth Pro latest price failed (${response.status})`);
    return parseSnapshot(instrument.mint, definitions, body);
  }
}

export class PythStockGuard implements StockMarketGuard {
  private readonly policy: PythMarketPolicy;

  constructor(
    private readonly source: PythProStockSource,
    policy: PythMarketPolicy,
    private readonly nowMs: () => number = Date.now,
  ) {
    validatePolicy(policy);
    this.policy = Object.freeze({ ...policy });
  }

  async assess(instrument: StockInstrument): Promise<StockMarketAssessment> {
    return evaluateSnapshot(await this.source.snapshot(instrument), this.policy, this.nowMs());
  }

  revalidate(assessment: StockMarketAssessment): StockMarketAssessment {
    const { allowed: _allowed, refusal: _refusal, ...snapshot } = assessment;
    return evaluateSnapshot(snapshot, this.policy, this.nowMs());
  }
}

function parseSnapshot(
  instrumentMint: string,
  definitions: PythInstrumentFeeds,
  body: unknown,
): Omit<StockMarketAssessment, "allowed" | "refusal" | "policy"> {
  const update = latestPriceSchema.parse(body);
  const timestampUs = asBigInt(update.parsed.timestampUs, "timestampUs");
  const underlying = requireFeed(update.parsed.priceFeeds, definitions.underlying);
  const tokenized = requireFeed(update.parsed.priceFeeds, definitions.tokenized);
  const commonExponent = Math.min(underlying.exponent, tokenized.exponent);
  const underlyingScaled = scale(positive(underlying.price, "underlying price"), underlying.exponent - commonExponent);
  const tokenizedScaled = scale(positive(tokenized.price, "tokenized price"), tokenized.exponent - commonExponent);
  const premiumBps = Number(((tokenizedScaled - underlyingScaled) * 10_000n) / underlyingScaled);
  const feeds = {
    underlying: pricePoint(underlying, definitions.underlying, timestampUs),
    tokenized: pricePoint(tokenized, definitions.tokenized, timestampUs),
  };
  const evidence = {
    provider: "pyth-pro" as const,
    instrument_mint: instrumentMint,
    timestamp_us: timestampUs.toString(),
    premium_bps: premiumBps,
    feeds: {
      underlying: evidencePoint(feeds.underlying),
      tokenized: evidencePoint(feeds.tokenized),
    },
    solana_payload_hash: sha256({ encoding: update.solana.encoding, data: update.solana.data }),
  };
  return {
    provider: evidence.provider,
    instrument_mint: evidence.instrument_mint,
    timestamp_us: evidence.timestamp_us,
    premium_bps: evidence.premium_bps,
    feeds,
    solana_payload_hash: evidence.solana_payload_hash,
    observed_at: new Date(Number(timestampUs / 1000n)).toISOString(),
    evidence_hash: sha256(evidence),
  };
}

function evaluateSnapshot(
  snapshot: Omit<StockMarketAssessment, "allowed" | "refusal" | "policy">,
  policy: PythMarketPolicy,
  nowMs: number,
): StockMarketAssessment {
  const timestampUs = BigInt(snapshot.timestamp_us);
  const feeds = {
    underlying: refreshAge(snapshot.feeds.underlying, timestampUs, nowMs),
    tokenized: refreshAge(snapshot.feeds.tokenized, timestampUs, nowMs),
  };
  let refusal: StockMarketAssessment["refusal"];
  const stale = [feeds.underlying, feeds.tokenized].find((feed) => feed.age_ms > policy.max_feed_age_seconds * 1000);
  const thin = [feeds.underlying, feeds.tokenized].find((feed) => feed.publisher_count < policy.min_publishers);
  const uncertain = [feeds.underlying, feeds.tokenized].find((feed) => feed.confidence_bps > policy.max_confidence_bps);
  if (stale) {
    refusal = { code: "PYTH_PRICE_STALE", message: `${stale.symbol} is ${stale.age_ms}ms old` };
  } else if (thin) {
    refusal = { code: "PYTH_PUBLISHERS_LOW", message: `${thin.symbol} has only ${thin.publisher_count} publishers` };
  } else if (uncertain) {
    refusal = { code: "PYTH_CONFIDENCE_WIDE", message: `${uncertain.symbol} confidence is ${uncertain.confidence_bps}bps` };
  } else if (Math.abs(snapshot.premium_bps) > policy.max_absolute_premium_bps) {
    refusal = {
      code: "PYTH_PRICE_DISLOCATION",
      message: `tokenized price differs from the underlying by ${snapshot.premium_bps}bps`,
    };
  }
  return {
    ...snapshot,
    feeds,
    policy: { ...policy },
    allowed: !refusal,
    refusal,
  };
}

function requireFeed(feeds: z.infer<typeof priceFeedSchema>[], definition: PythFeedDefinition) {
  const feed = feeds.find((candidate) => candidate.priceFeedId === definition.lazerId);
  if (!feed) throw new Error(`Pyth response omitted ${definition.symbol}`);
  return feed;
}

function pricePoint(
  feed: z.infer<typeof priceFeedSchema>,
  definition: PythFeedDefinition,
  timestampUs: bigint,
): PythPricePoint {
  const price = positive(feed.price, `${definition.symbol} price`);
  const confidence = asBigInt(feed.confidence, `${definition.symbol} confidence`);
  if (confidence < 0n) throw new Error(`${definition.symbol} confidence must be non-negative`);
  const feedUpdateUs = asBigInt(feed.feedUpdateTimestamp, `${definition.symbol} feedUpdateTimestamp`);
  if (feedUpdateUs > timestampUs + 5_000_000n) throw new Error(`${definition.symbol} update timestamp is in the future`);
  return {
    feed_id: feed.priceFeedId,
    symbol: definition.symbol,
    mantissa: price.toString(),
    exponent: feed.exponent,
    confidence: confidence.toString(),
    confidence_bps: Number((confidence * 10_000n) / price),
    publisher_count: feed.publisherCount,
    market_session: feed.marketSession,
    feed_update_timestamp_us: feedUpdateUs.toString(),
    age_ms: Number((timestampUs - feedUpdateUs) / 1000n),
  };
}

function refreshAge(point: PythPricePoint, timestampUs: bigint, nowMs: number): PythPricePoint {
  const updateMs = Number(BigInt(point.feed_update_timestamp_us) / 1000n);
  const responseMs = Number(timestampUs / 1000n);
  if (nowMs < responseMs - 5_000) throw new Error("Pyth response timestamp is in the future");
  return { ...point, age_ms: Math.max(0, nowMs - updateMs) };
}

function evidencePoint(point: PythPricePoint): Omit<PythPricePoint, "age_ms"> {
  const { age_ms: _derived, ...evidence } = point;
  return evidence;
}

function asBigInt(value: string | number, field: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${field} is not an integer`);
  }
}

function positive(value: string | number, field: string): bigint {
  const parsed = asBigInt(value, field);
  if (parsed <= 0n) throw new Error(`${field} must be positive`);
  return parsed;
}

function scale(value: bigint, decimalPlaces: number): bigint {
  if (decimalPlaces < 0 || decimalPlaces > 36) throw new Error("unsupported Pyth exponent difference");
  return value * (10n ** BigInt(decimalPlaces));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validatePolicy(policy: PythMarketPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  }
  if (policy.max_feed_age_seconds === 0) throw new Error("max_feed_age_seconds must be positive");
  if (policy.min_publishers === 0) throw new Error("min_publishers must be positive");
}
