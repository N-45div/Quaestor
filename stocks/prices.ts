/**
 * A live price tape for listed instruments, kept in the hub's memory.
 *
 * An agent deciding whether to buy a tokenized stock needs more than the price
 * this second. It needs to know where the token has been, where its underlying
 * has been, and how far apart they are — and it needs that already assembled
 * when it asks, not fetched on demand the moment it has to decide. So the hub
 * samples continuously into a rolling buffer, backfills history on start, and
 * serves a summary written for a model to read: figures that are already
 * computed, a short sparkline, and one plain paragraph saying what happened.
 *
 * Two sides are tracked per instrument, because the interesting number is the
 * distance between them:
 *
 *   tokenized  — the on-chain token's market price (Jupiter live, GeckoTerminal
 *                pool candles for history)
 *   reference  — an off-chain reference for the underlying stock (Backpack's
 *                perp *index* price, live and historical)
 *
 * None of these sources are signed. The tape informs decisions and the
 * explorer; what the program enforces is still the balance postconditions.
 */
import type { StockInstrument } from "./types";

export type PriceSide = "tokenized" | "reference";

export interface PricePoint {
  /** Unix seconds. */
  t: number;
  price: number;
  source: string;
}

// -------------------------------------------------------------------- tape

export interface PriceTapeOptions {
  /** Points older than this are dropped. Default 24h. */
  maxAgeSeconds?: number;
  /** Hard cap per series, so a noisy source cannot grow memory without bound. */
  maxPoints?: number;
  now?: () => number;
}

export class PriceTape {
  private readonly series_ = new Map<string, PricePoint[]>();
  /**
   * The same points, kept apart by the source that published them.
   *
   * The merged series above is what a chart wants: one line per side, the most
   * recent word on each second. But collapsing two feeds into one line destroys
   * the question the price gate has to answer — *do independent sources agree?*
   * A disagreement is only visible while the sources are still distinguishable.
   */
  private readonly bySource_ = new Map<string, PricePoint[]>();
  private readonly maxAgeSeconds: number;
  private readonly maxPoints: number;
  private readonly now: () => number;

  constructor(options: PriceTapeOptions = {}) {
    this.maxAgeSeconds = options.maxAgeSeconds ?? 86_400;
    this.maxPoints = options.maxPoints ?? 5_000;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private key(mint: string, side: PriceSide): string {
    return `${mint}:${side}`;
  }

  /**
   * Merge points into a series. Two points at the same second collapse to the
   * one merged last, so a live sample and a backfilled candle for the same
   * instant never double-count.
   */
  record(mint: string, side: PriceSide, ...points: PricePoint[]): void {
    const valid = points.filter((p) => Number.isFinite(p.price) && p.price > 0 && Number.isFinite(p.t));
    if (valid.length === 0) return;
    const cutoff = this.now() - this.maxAgeSeconds;
    this.series_.set(this.key(mint, side), this.merge(this.key(mint, side), this.series_, valid, cutoff));
    for (const source of new Set(valid.map((p) => p.source))) {
      const key = `${this.key(mint, side)}:${source}`;
      const own = valid.filter((p) => p.source === source);
      this.bySource_.set(key, this.merge(key, this.bySource_, own, cutoff));
    }
  }

  private merge(
    key: string,
    into: Map<string, PricePoint[]>,
    points: PricePoint[],
    cutoff: number,
  ): PricePoint[] {
    const byTime = new Map<number, PricePoint>();
    for (const p of into.get(key) ?? []) byTime.set(p.t, p);
    for (const p of points) byTime.set(p.t, p);
    return [...byTime.values()]
      .filter((p) => p.t >= cutoff)
      .sort((a, b) => a.t - b.t)
      .slice(-this.maxPoints);
  }

  /**
   * The most recent price from every source that publishes this side — the
   * input to "do independent sources agree", which the merged series cannot
   * answer because it has already thrown the disagreement away.
   */
  latestPerSource(mint: string, side: PriceSide): PricePoint[] {
    const prefix = `${this.key(mint, side)}:`;
    const latest: PricePoint[] = [];
    for (const [key, series] of this.bySource_) {
      if (!key.startsWith(prefix)) continue;
      const last = series[series.length - 1];
      if (last) latest.push(last);
    }
    return latest.sort((a, b) => a.source.localeCompare(b.source));
  }

  series(mint: string, side: PriceSide, sinceSeconds = 0): PricePoint[] {
    return (this.series_.get(this.key(mint, side)) ?? []).filter((p) => p.t >= sinceSeconds);
  }

  latest(mint: string, side: PriceSide): PricePoint | undefined {
    const s = this.series_.get(this.key(mint, side));
    return s?.[s.length - 1];
  }

  /** The last point at or before `t` — how a market price actually carries forward. */
  at(mint: string, side: PriceSide, t: number): PricePoint | undefined {
    const s = this.series_.get(this.key(mint, side)) ?? [];
    let found: PricePoint | undefined;
    for (const p of s) {
      if (p.t > t) break;
      found = p;
    }
    return found;
  }
}

/** Windows an agent may ask for. The tape keeps 24h, so nothing longer is honest. */
export const PRICE_WINDOW_MIN_SECONDS = 5 * 60;
export const PRICE_WINDOW_MAX_SECONDS = 24 * 3_600;

/** "15m", "1h", "6h", "1d" → seconds. Throws on anything else, rather than guessing. */
export function parseWindow(window: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(window.trim());
  if (!match) throw new Error(`window must look like 15m, 1h or 1d, got "${window}"`);
  const seconds = Number(match[1]) * { m: 60, h: 3_600, d: 86_400 }[match[2] as "m" | "h" | "d"];
  if (seconds < PRICE_WINDOW_MIN_SECONDS || seconds > PRICE_WINDOW_MAX_SECONDS) {
    throw new Error(`window must be between 5m and 24h, got "${window}"`);
  }
  return seconds;
}

// ----------------------------------------------------------- market session

export type UsEquitySession = "regular" | "pre-market" | "after-hours" | "overnight" | "weekend";

/**
 * The US equity session by the New York clock. Exchange holidays are not
 * modelled, and the output says so rather than pretending otherwise.
 */
export function usEquitySession(unixSeconds: number): UsEquitySession {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(unixSeconds * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  if (weekday === "Sat" || weekday === "Sun") return "weekend";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "pre-market";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "after-hours";
  return "overnight";
}

// ----------------------------------------------------------------- summary

export interface SideSummary {
  source: string;
  last: number;
  first: number;
  change_pct: number;
  high: number;
  low: number;
  /** (high − low) / low. Raw range rather than volatility: samples are uneven. */
  range_pct: number;
  points: number;
  last_update_age_s: number;
}

export interface PremiumSummary {
  /** Tokenized minus reference, in basis points of the reference. */
  now_bps: number;
  start_bps: number;
  mean_bps: number;
  min_bps: number;
  max_bps: number;
  trend: "widening" | "narrowing" | "stable";
}

export interface PriceBucket {
  t: number;
  tokenized?: number;
  reference?: number;
  premium_bps?: number;
}

export interface PriceSummary {
  instrument: { symbol: string; mint: string; underlying?: string };
  window_seconds: number;
  generated_at: string;
  tokenized: SideSummary | null;
  reference: SideSummary | null;
  premium: PremiumSummary | null;
  session: { us_equity: UsEquitySession; basis: string };
  sparkline: { tokenized: string; reference: string; premium: string };
  /** Deterministic — no model wrote this. It states only what the figures show. */
  narrative: string;
  /** Aligned buckets with the last known price carried forward, ≤ `buckets` rows. */
  series: PriceBucket[];
}

const TICKS = "▁▂▃▄▅▆▇█";

export function sparkline(values: number[]): string {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return "";
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  return values
    .map((v) => {
      if (!Number.isFinite(v)) return " ";
      if (hi === lo) return TICKS[3];
      return TICKS[Math.round(((v - lo) / (hi - lo)) * (TICKS.length - 1))];
    })
    .join("");
}

function sideSummary(points: PricePoint[], now: number): SideSummary | null {
  if (points.length === 0) return null;
  const prices = points.map((p) => p.price);
  const first = prices[0];
  const last = prices[prices.length - 1];
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  return {
    source: points[points.length - 1].source,
    last,
    first,
    change_pct: round(((last - first) / first) * 100, 3),
    high,
    low,
    range_pct: round(((high - low) / low) * 100, 3),
    points: points.length,
    last_update_age_s: Math.max(0, now - points[points.length - 1].t),
  };
}

const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;
const bps = (tokenized: number, reference: number) => Math.round(((tokenized - reference) / reference) * 10_000);
const usd = (v: number) => `$${v.toFixed(2)}`;

/** A trend needs to move this many basis points before it is called one. */
const TREND_BPS = 10;

export interface SummaryOptions {
  windowSeconds: number;
  buckets?: number;
  now?: number;
  /**
   * How long a price may be carried forward before it stops counting. A trade
   * from fifteen minutes ago compared with a reference from now is not a
   * premium, it is two moments read as one — so past this, the bucket is left
   * empty, which says "unknown" and is true.
   */
  maxCarrySeconds?: number;
}

export function summarize(
  tape: PriceTape,
  instrument: Pick<StockInstrument, "symbol" | "mint" | "underlyingSymbol">,
  options: SummaryOptions,
): PriceSummary {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const from = now - options.windowSeconds;
  const bucketCount = Math.max(2, options.buckets ?? 48);
  const width = options.windowSeconds / bucketCount;

  const tokenized = sideSummary(tape.series(instrument.mint, "tokenized", from), now);
  const reference = sideSummary(tape.series(instrument.mint, "reference", from), now);

  const carry = options.maxCarrySeconds ?? 900;
  const fresh = (side: PriceSide, t: number) => {
    const point = tape.at(instrument.mint, side, t);
    return point && t - point.t <= carry ? point.price : undefined;
  };
  const series: PriceBucket[] = [];
  for (let i = 1; i <= bucketCount; i += 1) {
    const t = Math.round(from + i * width);
    const tok = fresh("tokenized", t);
    const ref = fresh("reference", t);
    series.push({
      t,
      ...(tok !== undefined ? { tokenized: round(tok, 4) } : {}),
      ...(ref !== undefined ? { reference: round(ref, 4) } : {}),
      ...(tok !== undefined && ref !== undefined ? { premium_bps: bps(tok, ref) } : {}),
    });
  }

  const premiums = series.map((b) => b.premium_bps).filter((v): v is number => v !== undefined);
  let premium: PremiumSummary | null = null;
  if (premiums.length > 0) {
    const start = premiums[0];
    const nowBps = premiums[premiums.length - 1];
    const drift = Math.abs(nowBps) - Math.abs(start);
    premium = {
      now_bps: nowBps,
      start_bps: start,
      mean_bps: Math.round(premiums.reduce((a, b) => a + b, 0) / premiums.length),
      min_bps: Math.min(...premiums),
      max_bps: Math.max(...premiums),
      trend: drift > TREND_BPS ? "widening" : drift < -TREND_BPS ? "narrowing" : "stable",
    };
  }

  const session = usEquitySession(now);
  const summary: PriceSummary = {
    instrument: { symbol: instrument.symbol, mint: instrument.mint, underlying: instrument.underlyingSymbol },
    window_seconds: options.windowSeconds,
    generated_at: new Date(now * 1000).toISOString(),
    tokenized,
    reference,
    premium,
    session: { us_equity: session, basis: "New York clock; exchange holidays not modelled" },
    sparkline: {
      tokenized: sparkline(series.map((b) => b.tokenized ?? Number.NaN)),
      reference: sparkline(series.map((b) => b.reference ?? Number.NaN)),
      premium: sparkline(series.map((b) => b.premium_bps ?? Number.NaN)),
    },
    narrative: "",
    series,
  };
  summary.narrative = narrate(summary);
  return summary;
}

function windowLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${Math.round(seconds / 60)}m`;
}

/** One paragraph, built only from the figures, so it can never say more than they do. */
function narrate(s: PriceSummary): string {
  const w = windowLabel(s.window_seconds);
  const parts: string[] = [];
  const sym = s.instrument.symbol;
  const under = s.instrument.underlying ?? "its underlying";

  if (s.tokenized) {
    const t = s.tokenized;
    parts.push(
      `Over the last ${w}, ${sym} traded between ${usd(t.low)} and ${usd(t.high)}; last ${usd(t.last)} (${t.change_pct >= 0 ? "+" : ""}${t.change_pct}%).`,
    );
    if (t.last_update_age_s > 300) parts.push(`Its latest price is ${Math.round(t.last_update_age_s / 60)} minutes old.`);
  } else {
    parts.push(`No tokenized price for ${sym} in the last ${w}.`);
  }

  if (s.reference) {
    const r = s.reference;
    parts.push(
      r.range_pct < 0.05
        ? `The ${under} reference was flat at ${usd(r.last)}.`
        : `The ${under} reference moved ${r.change_pct >= 0 ? "+" : ""}${r.change_pct}% to ${usd(r.last)}.`,
    );
  } else {
    parts.push(`No reference price for ${under} is available.`);
  }

  if (s.premium) {
    const p = s.premium;
    const where = p.now_bps === 0
      ? "The token is level with its reference"
      : `The token sits ${Math.abs(p.now_bps)} bps ${p.now_bps > 0 ? "above" : "below"} its reference`;
    const trend = p.trend === "stable" ? "and has held near there" : `${p.trend} from ${p.start_bps} bps`;
    parts.push(`${where}, ${trend} (range ${p.min_bps} to ${p.max_bps} bps).`);
  }

  if (s.session.us_equity !== "regular") {
    // Only what is grounded: issuers cap mint/redeem outside regular hours (the
    // xStocks API publishes lower overnight limits and zero at weekends), so
    // the arbitrage that pulls a token back to its underlying is weaker.
    parts.push(
      `US market: ${s.session.us_equity}. Outside regular hours the issuer's mint and redeem limits are lower, so arbitrage is weaker and a gap can persist.`,
    );
  }
  return parts.join(" ");
}

// ------------------------------------------------------------------ sources

export interface LiveSample {
  mint: string;
  side: PriceSide;
  point: PricePoint;
}

export interface TapeSource {
  readonly id: string;
  readonly side: PriceSide;
  /** Current price for many instruments at once — one request per tick. */
  sample(instruments: readonly StockInstrument[]): Promise<LiveSample[]>;
  /** History for one instrument, if the source keeps any. */
  history?(instrument: StockInstrument, sinceSeconds: number): Promise<PricePoint[]>;
}

const timeout = (ms: number) => AbortSignal.timeout(ms);

async function json<T>(request: typeof fetch, url: string): Promise<T> {
  const response = await request(url, { headers: { Accept: "application/json" }, signal: timeout(15_000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Backpack's stock perps publish an *index* price — the exchange's reference for
 * the underlying — separately from the perp's own trades. The index is the one
 * used here, live and historical, so the reference line is one series rather
 * than a trade price stitched onto an index.
 */
export class BackpackIndexSource implements TapeSource {
  readonly id = "backpack-index";
  readonly side = "reference" as const;

  constructor(
    private readonly baseUrl = "https://api.backpack.exchange",
    private readonly request: typeof fetch = fetch,
  ) {}

  static symbolFor(instrument: Pick<StockInstrument, "underlyingSymbol">): string | undefined {
    return instrument.underlyingSymbol ? `${instrument.underlyingSymbol}.US_USDC_PERP` : undefined;
  }

  async sample(instruments: readonly StockInstrument[]): Promise<LiveSample[]> {
    // Several tokens can share an underlying (AAPLx, the devnet test mint and
    // the AAPL curve all track AAPL), and each needs its own reference sample:
    // one mint per symbol left every other one reading a price from boot.
    const wanted = new Map<string, string[]>();
    for (const i of instruments) {
      const symbol = BackpackIndexSource.symbolFor(i);
      if (symbol) wanted.set(symbol, [...(wanted.get(symbol) ?? []), i.mint]);
    }
    if (wanted.size === 0) return [];
    const marks = await json<Array<{ symbol: string; indexPrice: string }>>(this.request, `${this.baseUrl}/api/v1/markPrices`);
    const t = Math.floor(Date.now() / 1000);
    return marks.flatMap((m) => (wanted.get(m.symbol) ?? []).map((mint) => ({
      mint,
      side: this.side,
      point: { t, price: Number(m.indexPrice), source: this.id },
    })));
  }

  async history(instrument: StockInstrument, sinceSeconds: number): Promise<PricePoint[]> {
    const symbol = BackpackIndexSource.symbolFor(instrument);
    if (!symbol) return [];
    const candles = await json<Array<{ end: string; close: string }>>(
      this.request,
      `${this.baseUrl}/api/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&priceType=Index&startTime=${sinceSeconds}`,
    );
    return candles.map((c) => ({
      // Backpack prints "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
      t: Math.floor(Date.parse(`${c.end.replace(" ", "T")}Z`) / 1000),
      price: Number(c.close),
      source: this.id,
    }));
  }
}

/** What Jupiter publishes per mint. Two prices, and how to read the token's units. */
interface JupiterPriceEntry {
  /** The on-chain token's price, in UI units. */
  usdPrice?: number;
  /** The issuer's own price for the underlying share, with its own clock. */
  stockData?: { price?: number; updatedAt?: string };
  /**
   * xStocks are Token-2022 scaled-UI-amount mints: one UI share is
   * `multiplier` raw units, and the multiplier grows as the issuer accrues
   * dividends into it. Ignoring it prices a raw amount ~0.3% wrong today, and
   * by more every quarter.
   */
  scaledUiConfig?: { multiplier?: number; newMultiplier?: number; newMultiplierEffectiveAt?: string };
}

/**
 * Jupiter's price endpoint, read for everything it says rather than the one
 * field the chart needs.
 *
 * One request carries three facts per mint: what the token trades at on chain,
 * what the issuer says the underlying share is worth, and the scaling between
 * raw token units and UI shares. The second is a *reference* price from an
 * entirely different party than Backpack's index — a second opinion on the same
 * question, free, on a request already being made.
 */
export class JupiterPriceSource implements TapeSource {
  readonly id = "jupiter";
  readonly side = "tokenized" as const;
  /** The id the issuer's underlying price is recorded under, kept apart from ours. */
  static readonly STOCK_SOURCE_ID = "jupiter-issuer";
  private readonly multipliers = new Map<string, number>();

  constructor(
    private readonly baseUrl = "https://lite-api.jup.ag/price/v3",
    private readonly request: typeof fetch = fetch,
  ) {}

  /** Raw base units per UI share, once observed. Absent until the first tick. */
  multiplier(mint: string): number | undefined {
    return this.multipliers.get(mint);
  }

  async sample(instruments: readonly StockInstrument[]): Promise<LiveSample[]> {
    if (instruments.length === 0) return [];
    const out: LiveSample[] = [];
    const t = Math.floor(Date.now() / 1000);
    // The endpoint caps how many ids one request may carry.
    for (let i = 0; i < instruments.length; i += 50) {
      const batch = instruments.slice(i, i + 50);
      const body = await json<Record<string, JupiterPriceEntry>>(
        this.request,
        `${this.baseUrl}?ids=${batch.map((b) => b.mint).join(",")}`,
      );
      for (const instrument of batch) {
        const entry = body[instrument.mint];
        if (entry) out.push(...this.read(instrument.mint, entry, t));
      }
    }
    return out;
  }

  private read(mint: string, entry: JupiterPriceEntry, t: number): LiveSample[] {
    const multiplier = effectiveMultiplier(entry.scaledUiConfig, t);
    if (multiplier !== undefined) this.multipliers.set(mint, multiplier);

    const samples: LiveSample[] = [];
    if (entry.usdPrice !== undefined) {
      samples.push({ mint, side: this.side, point: { t, price: entry.usdPrice, source: this.id } });
    }
    if (entry.stockData?.price !== undefined) {
      // Stamped with the issuer's own clock, not ours: outside market hours
      // this price stops moving, and the gate should see it age.
      const updated = entry.stockData.updatedAt
        ? Math.floor(Date.parse(entry.stockData.updatedAt) / 1000)
        : Number.NaN;
      samples.push({
        mint,
        side: "reference",
        point: {
          t: Number.isFinite(updated) ? Math.min(updated, t) : t,
          price: entry.stockData.price,
          source: JupiterPriceSource.STOCK_SOURCE_ID,
        },
      });
    }
    return samples;
  }
}

/** The multiplier in force now: a scheduled one once its effective moment has passed. */
function effectiveMultiplier(
  config: JupiterPriceEntry["scaledUiConfig"],
  nowSeconds: number,
): number | undefined {
  if (!config) return undefined;
  const effectiveAt = config.newMultiplierEffectiveAt
    ? Math.floor(Date.parse(config.newMultiplierEffectiveAt) / 1000)
    : Number.NaN;
  const scheduled = Number.isFinite(effectiveAt) && effectiveAt <= nowSeconds ? config.newMultiplier : undefined;
  const value = scheduled ?? config.multiplier;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * History for the tokenized side, from the deepest USDC pool GeckoTerminal
 * indexes for the mint. Candles exist only for minutes that traded, so the
 * series is uneven by nature; the summary carries the last trade forward.
 */
export class GeckoTerminalHistorySource implements TapeSource {
  readonly id = "geckoterminal";
  readonly side = "tokenized" as const;
  private readonly pools = new Map<string, string | null>();
  /** Requests are serialised through this chain, spaced to stay under the public limit. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly baseUrl = "https://api.geckoterminal.com/api/v2",
    private readonly request: typeof fetch = fetch,
    /** The public tier throttles bursts well before its per-minute ceiling. */
    private readonly spacingMs = 2_500,
    private readonly retryAfterMs = 15_000,
  ) {}

  private get<T>(url: string): Promise<T> {
    const run = async (): Promise<T> => {
      await new Promise((resolve) => setTimeout(resolve, this.spacingMs));
      try {
        return await json<T>(this.request, url);
      } catch (error) {
        // One patient retry on a rate limit; anything else is a real failure.
        if (!/returned 429/.test((error as Error).message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.retryAfterMs));
        return json<T>(this.request, url);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async sample(): Promise<LiveSample[]> {
    // History only: its public tier allows ~30 requests a minute, which is for
    // backfilling, not for a live tick across every instrument.
    return [];
  }

  private async poolFor(mint: string): Promise<string | null> {
    if (this.pools.has(mint)) return this.pools.get(mint)!;
    const body = await this.get<{
      data?: Array<{ attributes: { address: string; name: string; reserve_in_usd: string } }>;
    }>(`${this.baseUrl}/networks/solana/tokens/${mint}/pools?page=1`);
    const best = (body.data ?? [])
      .filter((p) => /\/\s*USDC\b/.test(p.attributes.name))
      .sort((a, b) => Number(b.attributes.reserve_in_usd) - Number(a.attributes.reserve_in_usd))[0];
    const pool = best?.attributes.address ?? null;
    this.pools.set(mint, pool);
    return pool;
  }

  async history(instrument: StockInstrument, sinceSeconds: number): Promise<PricePoint[]> {
    const pool = await this.poolFor(instrument.mint);
    if (!pool) return [];
    const body = await this.get<{ data: { attributes: { ohlcv_list: number[][] } } }>(
      `${this.baseUrl}/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=${instrument.mint}`,
    );
    return body.data.attributes.ohlcv_list
      .filter((c) => c[0] >= sinceSeconds)
      .map((c) => ({ t: c[0], price: c[4], source: this.id }));
  }
}

/**
 * Copies one instrument's reference prices onto another.
 *
 * A devnet test mint has no market of its own, but the share it stands in for
 * does, and the sources that price that share key on things the test mint does
 * not have — a Jupiter listing, an exchange symbol. Mirroring carries their
 * prices across with their own ids and timestamps intact, so the gate sees the
 * same two independent opinions it would see on mainnet rather than a single
 * source it cannot cross-check.
 *
 * Only ever point this at an instrument with no market of its own. Mirroring
 * onto something that trades would manufacture agreement between a price and
 * itself, which is the one thing the gate must never be fooled by.
 */
export class ReferenceMirrorSource implements TapeSource {
  readonly id = "mirror";
  readonly side = "reference" as const;

  /** `links` maps the borrowing mint to the mint whose reference it borrows. */
  constructor(
    private readonly tape: PriceTape,
    private readonly links: ReadonlyMap<string, string>,
  ) {}

  async sample(): Promise<LiveSample[]> {
    const out: LiveSample[] = [];
    for (const [target, origin] of this.links) {
      // Each source keeps its own identity and clock across the copy; a
      // mirrored price that claimed to be fresh would defeat the staleness check.
      for (const point of this.tape.latestPerSource(origin, this.side)) {
        out.push({ mint: target, side: this.side, point });
      }
    }
    return out;
  }
}

// ----------------------------------------------------------------- sampler

export interface PriceSamplerOptions {
  intervalMs?: number;
  backfillSeconds?: number;
  onError?: (source: string, error: unknown) => void;
}

/**
 * Keeps the tape current. One request per source per tick, never one per
 * instrument, so adding instruments does not multiply the load on free APIs.
 * A source that fails is skipped for that tick; the others still record.
 */
export class PriceSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly backfillSeconds: number;

  constructor(
    readonly tape: PriceTape,
    private readonly instruments: () => readonly StockInstrument[],
    private readonly sources: readonly TapeSource[],
    private readonly options: PriceSamplerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 20_000;
    this.backfillSeconds = options.backfillSeconds ?? 6 * 3_600;
  }

  async backfill(): Promise<void> {
    const since = Math.floor(Date.now() / 1000) - this.backfillSeconds;
    for (const source of this.sources) {
      if (!source.history) continue;
      for (const instrument of this.instruments()) {
        try {
          this.tape.record(instrument.mint, source.side, ...(await source.history(instrument, since)));
        } catch (error) {
          this.options.onError?.(source.id, error);
        }
      }
    }
  }

  async tick(): Promise<void> {
    const instruments = this.instruments();
    await Promise.all(this.sources.map(async (source) => {
      try {
        for (const s of await source.sample(instruments)) this.tape.record(s.mint, s.side, s.point);
      } catch (error) {
        this.options.onError?.(source.id, error);
      }
    }));
  }

  start(): void {
    if (this.timer) return;
    void this.backfill().then(() => this.tick());
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // The sampler must never be the reason a process stays alive.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
