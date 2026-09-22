/**
 * The price gate.
 *
 * What the program enforces is a balance postcondition: the vault gave up no
 * more than `amountIn`, and the position gained at least `minOutput`. That is a
 * real guarantee and it has one gap — `minOutput` comes from the quote. A venue
 * that quotes a price far from the market satisfies the postcondition perfectly
 * while handing the agent a terrible trade, and the chain has no way to know,
 * because the chain has never seen a price.
 *
 * This is what makes `minOutput` itself defensible. Before an intent is signed,
 * five questions are asked of prices observed *independently of the venue that
 * quoted*, and one of the issuer's schedule, and any one of them can refuse the
 * trade:
 *
 *   MARKET_DATA_UNAVAILABLE  nothing published a price for a side the owner
 *                            requires — so there is nothing to check against
 *   MARKET_DATA_STALE        prices exist but none recent enough to be a price
 *   MARKET_SOURCES_DISAGREE  two independent sources price the same side
 *                            differently, so neither can be believed
 *   SESSION_CLOSED           the owner does not permit trading in this session
 *   MULTIPLIER_CHANGE        the issuer's scaled-UI multiplier changes within
 *                            minutes of now, on one side or the other
 *   PRICE_DISLOCATION        the token has come loose from its underlying
 *   QUOTE_OFF_MARKET         the floor this quote guarantees is not a price the
 *                            observed market supports
 *
 * It fails closed in every direction: no data refuses, stale data refuses,
 * disagreement refuses. A gate that waved trades through when its evidence was
 * missing would be worse than no gate, because it would look like one.
 *
 * The schedule is the exception, and deliberately. xStocks and some PreStocks
 * are Token-2022 scaled-UI mints: a raw amount is worth a different number of
 * shares either side of a multiplier change, and the venue, the price feed and
 * this gate do not all switch at the same second. The issuer asks venues to
 * pause for about fifteen minutes either side of each change, so the gate does.
 * But a mint with no change scheduled publishes no moment, and that is not
 * missing evidence: absence refuses nothing here.
 *
 * None of these sources are signed, and the assessment says so by naming each
 * one. This is evidence for a decision, recorded in the decision record and
 * hashed into the intent — not a substitute for the postconditions.
 */
import { createHash } from "node:crypto";
import {
  usEquitySession,
  type PriceSide,
  type PriceTape,
  type UsEquitySession,
} from "./prices";
import type { StockInstrument } from "./types";

export type StockMarketRefusalCode =
  | "MARKET_DATA_UNAVAILABLE"
  | "MARKET_DATA_STALE"
  | "MARKET_SOURCES_DISAGREE"
  | "SESSION_CLOSED"
  | "MULTIPLIER_CHANGE"
  | "PRICE_DISLOCATION"
  | "QUOTE_OFF_MARKET";

export interface MarketPolicy {
  /** Past this, an observation is a record of a price, not a price. */
  max_price_age_seconds: number;
  /** Sides that must carry a fresh price before any trade is allowed. */
  required_sides: readonly PriceSide[];
  /** How far two sources pricing the same side may differ before neither is believed. */
  max_source_disagreement_bps: number;
  /** How far the token may sit from its underlying during regular US hours. */
  max_absolute_premium_bps: number;
  /**
   * The same limit outside regular hours. Issuers cut mint and redeem limits
   * overnight and to zero at weekends, so the arbitrage that closes a gap is
   * weaker and a wider gap is ordinary rather than alarming. One band for both
   * would either refuse normal overnight trading or accept a daytime break.
   */
  max_absolute_premium_bps_after_hours: number;
  /**
   * How far the quote's guaranteed floor may sit from the observed market.
   * It must exceed the slippage tolerance: a floor is *meant* to imply a worse
   * price than the market, by exactly that much.
   */
  max_quote_deviation_bps: number;
  /** Sessions this owner permits trading in at all. */
  allowed_sessions: readonly UsEquitySession[];
  /**
   * How long before and after a scheduled scaled-UI multiplier change nothing
   * trades. The issuer recommends about fifteen minutes; 0 turns the pause off.
   */
  multiplier_change_window_seconds: number;
}

/** One source's current word on one side of the pair. */
export interface MarketObservation {
  side: PriceSide;
  source: string;
  price: number;
  age_seconds: number;
}

export interface SideConsensus {
  /** The median, so one broken source among three cannot drag the number. */
  price: number;
  sources: string[];
  /** Spread between the highest and lowest source, in bps. Zero for one source. */
  spread_bps: number;
  /** Age of the freshest observation behind it. */
  age_seconds: number;
}

/**
 * What a quote implies about price, which is the thing being checked. Stated in
 * USD per share so it survives being stored and re-checked later: the amounts
 * do not change, but the market it is measured against does.
 */
export interface QuoteEvidence {
  quote_id: string;
  venue?: string;
  /** USD per share the guaranteed floor implies — the number the chain enforces. */
  floor_price_usd: number;
  /** USD per share the expected fill implies. Always the better of the two. */
  expected_price_usd: number;
  /** The observed price the floor was measured against. */
  benchmark_price_usd: number;
  benchmark_side: PriceSide;
  /** Floor against benchmark. Positive means paying more per share than the market. */
  deviation_bps: number;
  /** Raw units per UI share applied, where the mint scales them. */
  ui_multiplier: number;
}

export interface StockMarketAssessment {
  provider: string;
  instrument_mint: string;
  observed_at: string;
  session: UsEquitySession;
  /**
   * When the issuer's scaled-UI multiplier last changed or next changes, where
   * the mint has one scheduled. The chain keeps the moment after it passes, and
   * so does this, because the pause runs on both sides of it.
   */
  multiplier_change_at?: string;
  /** Tokenized against reference, in bps. Absent unless both sides have a price. */
  premium_bps?: number;
  allowed: boolean;
  refusal?: { code: StockMarketRefusalCode; message: string };
  policy: MarketPolicy;
  /**
   * Which of the owner's policies was applied: "default", or the name of the
   * one set for this kind of instrument. A listed share and a pre-IPO token do
   * not deserve the same tolerances, and a reader should not have to infer
   * which set of numbers they are looking at.
   */
  policy_scope: string;
  observations: MarketObservation[];
  consensus: Partial<Record<PriceSide, SideConsensus>>;
  /** Present once a quote has been measured against the evidence. */
  quote?: QuoteEvidence;
  /**
   * Hash of the prices, policy and quote — not of the moment. Two assessments
   * of an unchanged market hash alike, so the figure in a decision record
   * identifies the evidence a decision rested on.
   */
  evidence_hash: string;
}

/** A quote, in the units it was issued in, for the gate to price. */
export interface QuotedPrice {
  quote_id: string;
  venue?: string;
  /** USDC in, base units. */
  in_amount: bigint;
  in_decimals?: number;
  /** Expected instrument out, base units. */
  out_amount: bigint;
  /** The guaranteed floor, base units — the number the chain enforces. */
  minimum_output: bigint;
  out_decimals: number;
}

export interface StockMarketGuard {
  /** Current evidence for an instrument, with no quote in hand. */
  assess(instrument: StockInstrument): Promise<StockMarketAssessment>;
  /**
   * The same evidence with a quote measured against it. Pure with respect to
   * the caller: it adds the quote, it does not consume the previous verdict.
   */
  checkQuote(assessment: StockMarketAssessment, quote: QuotedPrice): StockMarketAssessment;
  /**
   * Re-decide at the current moment, using whatever the guard can obtain
   * without I/O. A guard whose data is already in memory should re-read it:
   * between quoting and executing, the market is exactly what may have moved.
   */
  revalidate(assessment: StockMarketAssessment): StockMarketAssessment;
}

export const DEFAULT_MARKET_POLICY: MarketPolicy = Object.freeze({
  max_price_age_seconds: 180,
  required_sides: Object.freeze(["reference"] as const),
  max_source_disagreement_bps: 150,
  max_absolute_premium_bps: 300,
  max_absolute_premium_bps_after_hours: 800,
  max_quote_deviation_bps: 300,
  allowed_sessions: Object.freeze(
    ["regular", "pre-market", "after-hours", "overnight", "weekend"] as const,
  ),
  multiplier_change_window_seconds: 900,
});

const SIDES: readonly PriceSide[] = Object.freeze(["tokenized", "reference"]);
const USDC_DECIMALS = 6;

// ------------------------------------------------------------------ the guard

export interface TapeMarketGuardConfig {
  tape: PriceTape;
  policy?: Partial<MarketPolicy>;
  /**
   * Named variations on `policy`, each stated as what differs from it. They are
   * validated when the guard is built, so a bad number stops the boot rather
   * than the first trade that would have used it.
   */
  policies?: Readonly<Record<string, Partial<MarketPolicy>>>;
  /**
   * Which named policy an instrument gets; undefined for the default. It is a
   * function rather than a table because some catalogues are discovered while
   * the hub runs, and a mint listed a minute ago must already have its limits.
   */
  policyFor?(mint: string): string | undefined;
  /**
   * Raw base units per UI share, for a mint whose UI amount is scaled — xStocks
   * accrue dividends into exactly such a multiplier. Without it a raw amount is
   * priced against a UI price, which is a different unit wearing the same name.
   */
  uiMultiplier?(mint: string): number | undefined;
  /**
   * When that multiplier last changed or next changes, in unix seconds, for a
   * mint that has a change scheduled; undefined for one that has none.
   */
  multiplierChangeAt?(mint: string): number | undefined;
  provider?: string;
  now?(): number;
}

/**
 * The gate, reading the hub's own price tape.
 *
 * The tape is already sampling continuously for the charts, so the evidence is
 * in memory when a quote arrives — the gate costs no request and adds no
 * latency to a trade, which is what lets it sit in the path of every one.
 */
export const DEFAULT_POLICY_SCOPE = "default";

export class TapeMarketGuard implements StockMarketGuard {
  private readonly policy: MarketPolicy;
  private readonly named = new Map<string, MarketPolicy>();
  private readonly provider: string;
  private readonly now: () => number;

  constructor(private readonly cfg: TapeMarketGuardConfig) {
    this.policy = validatePolicy({ ...DEFAULT_MARKET_POLICY, ...cfg.policy });
    for (const [name, difference] of Object.entries(cfg.policies ?? {})) {
      if (name === DEFAULT_POLICY_SCOPE) throw new Error(`"${DEFAULT_POLICY_SCOPE}" names the base policy and cannot be redefined`);
      this.named.set(name, validatePolicy({ ...this.policy, ...difference }));
    }
    this.provider = cfg.provider ?? "quaestor-tape";
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async assess(instrument: StockInstrument): Promise<StockMarketAssessment> {
    return this.evaluate(instrument.mint);
  }

  checkQuote(assessment: StockMarketAssessment, quote: QuotedPrice): StockMarketAssessment {
    const multiplier = this.cfg.uiMultiplier?.(assessment.instrument_mint) ?? 1;
    return this.evaluate(assessment.instrument_mint, impliedPrices(quote, multiplier));
  }

  revalidate(assessment: StockMarketAssessment): StockMarketAssessment {
    // The quote's implied prices are facts about the quote and do not move. The
    // market it is measured against does, which is the whole reason to re-run.
    return this.evaluate(assessment.instrument_mint, assessment.quote);
  }

  /**
   * The policy for one instrument, and its name. A name with no policy behind
   * it is a configuration mistake, and the mistake must not quietly become the
   * default's looser or tighter numbers, so it throws.
   */
  private scoped(mint: string): { policy: MarketPolicy; scope: string } {
    const scope = this.cfg.policyFor?.(mint);
    if (scope === undefined || scope === DEFAULT_POLICY_SCOPE) return { policy: this.policy, scope: DEFAULT_POLICY_SCOPE };
    const policy = this.named.get(scope);
    if (!policy) throw new Error(`no market policy is named "${scope}"`);
    return { policy, scope };
  }

  private evaluate(mint: string, quoted?: ImpliedPrices): StockMarketAssessment {
    const now = this.now();
    const { policy, scope } = this.scoped(mint);
    const observations: MarketObservation[] = [];
    for (const side of SIDES) {
      for (const point of this.cfg.tape.latestPerSource(mint, side)) {
        observations.push({
          side,
          source: point.source,
          price: point.price,
          age_seconds: Math.max(0, now - point.t),
        });
      }
    }
    return assemble({
      provider: this.provider,
      mint,
      observations,
      policy,
      scope,
      nowSeconds: now,
      multiplierChangeAt: this.cfg.multiplierChangeAt?.(mint),
      quoted,
    });
  }
}

// -------------------------------------------------------------- the reasoning

type ImpliedPrices = Pick<
  QuoteEvidence,
  "quote_id" | "venue" | "floor_price_usd" | "expected_price_usd" | "ui_multiplier"
>;

/** What a quote says a share costs, in the units a human prices shares in. */
export function impliedPrices(quote: QuotedPrice, uiMultiplier = 1): ImpliedPrices {
  if (quote.minimum_output <= 0n || quote.out_amount <= 0n) {
    throw new Error("a quote with no output implies no price");
  }
  if (!(uiMultiplier > 0) || !Number.isFinite(uiMultiplier)) {
    throw new Error("ui multiplier must be a positive number");
  }
  const usdIn = Number(quote.in_amount) / 10 ** (quote.in_decimals ?? USDC_DECIMALS);
  // A scaled-UI mint hands out raw units; the share count is the scaled one.
  const shares = (raw: bigint) => (Number(raw) / 10 ** quote.out_decimals) * uiMultiplier;
  return {
    quote_id: quote.quote_id,
    venue: quote.venue,
    floor_price_usd: usdIn / shares(quote.minimum_output),
    expected_price_usd: usdIn / shares(quote.out_amount),
    ui_multiplier: uiMultiplier,
  };
}

function assemble(input: {
  provider: string;
  mint: string;
  observations: MarketObservation[];
  policy: MarketPolicy;
  scope: string;
  nowSeconds: number;
  multiplierChangeAt?: number;
  quoted?: ImpliedPrices;
}): StockMarketAssessment {
  const { policy, observations } = input;
  const session = usEquitySession(input.nowSeconds);
  // Token-2022 writes 0 where nothing was ever scheduled, and 0 is not a moment.
  const scheduled = input.multiplierChangeAt;
  const changeAt = scheduled !== undefined && Number.isFinite(scheduled) && scheduled > 0 ? scheduled : undefined;
  const consensus: Partial<Record<PriceSide, SideConsensus>> = {};
  for (const side of SIDES) {
    const fresh = observations.filter(
      (o) => o.side === side && o.age_seconds <= policy.max_price_age_seconds,
    );
    const agreed = consensusOf(fresh);
    if (agreed) consensus[side] = agreed;
  }

  const premium = consensus.tokenized && consensus.reference
    ? bps(consensus.tokenized.price, consensus.reference.price)
    : undefined;

  // The token is what is being bought, so the token's own market is the
  // benchmark; the underlying stands in only where no token market exists.
  const benchmark = consensus.tokenized
    ? { side: "tokenized" as PriceSide, price: consensus.tokenized.price }
    : consensus.reference
      ? { side: "reference" as PriceSide, price: consensus.reference.price }
      : undefined;
  const quote: QuoteEvidence | undefined = input.quoted && benchmark
    ? {
      ...input.quoted,
      benchmark_price_usd: round(benchmark.price, 6),
      benchmark_side: benchmark.side,
      deviation_bps: bps(input.quoted.floor_price_usd, benchmark.price),
      floor_price_usd: round(input.quoted.floor_price_usd, 6),
      expected_price_usd: round(input.quoted.expected_price_usd, 6),
    }
    : undefined;

  const refusal = refuse({ observations, consensus, policy, session, nowSeconds: input.nowSeconds, changeAt, premium, quote });
  return {
    provider: input.provider,
    instrument_mint: input.mint,
    observed_at: new Date(input.nowSeconds * 1000).toISOString(),
    session,
    multiplier_change_at: changeAt === undefined ? undefined : iso(changeAt),
    premium_bps: premium,
    allowed: !refusal,
    refusal,
    policy: clonePolicy(policy),
    policy_scope: input.scope,
    observations: observations.map((o) => ({ ...o, price: round(o.price, 6) })),
    consensus,
    quote,
    evidence_hash: evidenceHash(input.provider, input.mint, policy, session, consensus, quote, changeAt),
  };
}

function consensusOf(fresh: MarketObservation[]): SideConsensus | undefined {
  if (fresh.length === 0) return undefined;
  const prices = fresh.map((o) => o.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return {
    price: round(median(prices), 6),
    sources: fresh.map((o) => o.source),
    spread_bps: bps(high, low),
    age_seconds: Math.min(...fresh.map((o) => o.age_seconds)),
  };
}

function refuse(input: {
  observations: MarketObservation[];
  consensus: Partial<Record<PriceSide, SideConsensus>>;
  policy: MarketPolicy;
  session: UsEquitySession;
  nowSeconds: number;
  changeAt?: number;
  premium?: number;
  quote?: QuoteEvidence;
}): { code: StockMarketRefusalCode; message: string } | undefined {
  const { policy, consensus, observations, session } = input;

  // Is there anything to check against? Asked first, because every question
  // below it is meaningless without an answer to this one.
  for (const side of policy.required_sides) {
    if (consensus[side]) continue;
    const seen = observations.filter((o) => o.side === side);
    if (seen.length === 0) {
      return {
        code: "MARKET_DATA_UNAVAILABLE",
        message: `no source published a ${side} price for this instrument`,
      };
    }
    const freshest = Math.min(...seen.map((o) => o.age_seconds));
    return {
      code: "MARKET_DATA_STALE",
      message: `every ${side} price is stale — the freshest is ${freshest}s old, past the ${policy.max_price_age_seconds}s limit`,
    };
  }

  // Can it be believed? Two sources that disagree are not a better price than
  // one source; they are an unanswered question about which is wrong.
  for (const side of SIDES) {
    const agreed = consensus[side];
    if (agreed && agreed.spread_bps > policy.max_source_disagreement_bps) {
      return {
        code: "MARKET_SOURCES_DISAGREE",
        message: `${agreed.sources.join(" and ")} differ by ${agreed.spread_bps}bps on the ${side} price, past the ${policy.max_source_disagreement_bps}bps limit`,
      };
    }
  }

  if (!policy.allowed_sessions.includes(session)) {
    return {
      code: "SESSION_CLOSED",
      message: `this owner does not permit trading during ${session}`,
    };
  }

  // Asked before the prices are judged, because across a change they are read
  // in two units at once: a gap here may be the multiplier, not the market.
  const pause = policy.multiplier_change_window_seconds;
  if (input.changeAt !== undefined && pause > 0 && Math.abs(input.nowSeconds - input.changeAt) <= pause) {
    const away = Math.abs(input.changeAt - input.nowSeconds);
    const when = input.changeAt >= input.nowSeconds
      ? `changes at ${iso(input.changeAt)}, in ${away}s`
      : `changed at ${iso(input.changeAt)}, ${away}s ago`;
    return {
      code: "MULTIPLIER_CHANGE",
      message: `the issuer's scaled-UI multiplier ${when}; nothing trades within ${pause}s either side of a change`,
    };
  }

  if (input.premium !== undefined) {
    const limit = session === "regular"
      ? policy.max_absolute_premium_bps
      : policy.max_absolute_premium_bps_after_hours;
    if (Math.abs(input.premium) > limit) {
      return {
        code: "PRICE_DISLOCATION",
        message: `the token sits ${input.premium}bps from its underlying, past the ${limit}bps allowed in ${session}`,
      };
    }
  }

  const quote = input.quote;
  if (quote && Math.abs(quote.deviation_bps) > policy.max_quote_deviation_bps) {
    const direction = quote.deviation_bps > 0 ? "above" : "below";
    return {
      code: "QUOTE_OFF_MARKET",
      message: `the floor this quote guarantees implies $${quote.floor_price_usd.toFixed(4)} a share, ${Math.abs(quote.deviation_bps)}bps ${direction} the observed ${quote.benchmark_side} price of $${quote.benchmark_price_usd.toFixed(4)}`,
    };
  }
  return undefined;
}

// --------------------------------------------------------------------- detail

const round = (value: number, dp: number) => Math.round(value * 10 ** dp) / 10 ** dp;

/** Relative difference in basis points. */
const bps = (value: number, base: number) => Math.round(((value - base) / base) * 10_000);

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clonePolicy(policy: MarketPolicy): MarketPolicy {
  return { ...policy, required_sides: [...policy.required_sides], allowed_sessions: [...policy.allowed_sessions] };
}

/**
 * Hashes the evidence, deliberately not the ages or the timestamp: those move
 * every second and would make the hash a clock rather than a fingerprint.
 */
function evidenceHash(
  provider: string,
  mint: string,
  policy: MarketPolicy,
  session: UsEquitySession,
  consensus: Partial<Record<PriceSide, SideConsensus>>,
  quote?: QuoteEvidence,
  multiplierChangeAt?: number,
): string {
  const stable = {
    provider,
    instrument_mint: mint,
    policy: clonePolicy(policy),
    session,
    multiplier_change_at: multiplierChangeAt ?? null,
    consensus: SIDES.map((side) => {
      const agreed = consensus[side];
      return agreed ? { side, price: agreed.price, sources: agreed.sources, spread_bps: agreed.spread_bps } : null;
    }),
    quote: quote
      ? {
        quote_id: quote.quote_id,
        floor_price_usd: quote.floor_price_usd,
        expected_price_usd: quote.expected_price_usd,
        benchmark_price_usd: quote.benchmark_price_usd,
        deviation_bps: quote.deviation_bps,
      }
      : null,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function validatePolicy(policy: MarketPolicy): MarketPolicy {
  const numbers: (keyof MarketPolicy)[] = [
    "max_price_age_seconds",
    "max_source_disagreement_bps",
    "max_absolute_premium_bps",
    "max_absolute_premium_bps_after_hours",
    "max_quote_deviation_bps",
    "multiplier_change_window_seconds",
  ];
  for (const field of numbers) {
    const value = policy[field] as number;
    if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  }
  if (policy.max_price_age_seconds === 0) throw new Error("max_price_age_seconds must be positive");
  if (policy.required_sides.length === 0) {
    // A gate that requires no price is not a gate; it would pass every trade
    // the moment its sources went dark, which is exactly when it should not.
    throw new Error("required_sides must name at least one side");
  }
  if (policy.allowed_sessions.length === 0) throw new Error("allowed_sessions must name at least one session");
  return Object.freeze(clonePolicy(policy));
}
