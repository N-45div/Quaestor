/**
 * A Meteora DBC launch for something that already has a price.
 *
 * A bonding curve is a price-discovery machine, and nearly every launch on one
 * starts near zero and lets the crowd find a number. That is the right shape for
 * a token nobody can value. A tokenized stock is the opposite case: its fair
 * value is printed on an exchange all day, and the only thing left to discover
 * is how far a thin new pair will wander from it. A curve that starts at zero
 * does not discover that; it pays whoever arrives first.
 *
 * So this plans a curve that lives entirely inside a band around the reference
 * price: it opens a little below it, graduates a little above it, and puts its
 * depth in the middle. Buying near fair value moves the price least, and each
 * step further from it costs more, which is the closest a constant-liquidity
 * segment curve gets to pulling a price back toward something.
 *
 * The plan is a pure function of its inputs. It reads no network and no clock,
 * so an issuer can see exactly what they would sign before anything is signed,
 * and the same inputs give the same curve.
 */
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DammV2DynamicFeeMode,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithLiquidityWeights,
  getPriceFromSqrtPrice,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

/** DBC curves are described in sixteen segments. */
export const CURVE_SEGMENTS = 16;

export interface StockLaunchInput {
  /** The underlying's price in USD, from sources independent of this pool. */
  referenceUsd: number;
  /** Half-width of the curve around the reference. 300 opens 3% under and graduates 3% over. */
  bandBps: number;
  /** USDC the curve should have taken in by the time it graduates. */
  raiseUsdc: number;
  /**
   * How strongly depth concentrates at the reference: 0 spreads it evenly, 1 is
   * the default bell, higher is narrower. Evenly spread is a plain ranged pool;
   * the bell is what makes the middle cheap to trade and the edges dear.
   */
  concentration?: number;
  /** The fee a buyer pays at the moment of launch, decaying to `endingFeeBps`. It is what a sniper pays. */
  startingFeeBps?: number;
  endingFeeBps?: number;
  feeDecaySeconds?: number;
  /** The pool it graduates into charges this. */
  graduatedPoolFeeBps?: number;
  /** Share of the graduated pool's liquidity locked for good, in percent. */
  lockedLiquidityPercent?: number;
  tokenType?: TokenType;
}

export interface StockLaunchPlan {
  input: Required<Omit<StockLaunchInput, "tokenType">> & { tokenType: TokenType };
  /** Whole tokens. One token is one share of exposure, so this is small. */
  totalSupply: number;
  /** Kept back for the builder's rounding; returned to the issuer at graduation. */
  leftover: number;
  openingPriceUsd: number;
  graduationPriceUsd: number;
  /** What the built curve actually needs to graduate; within a rounding of `raiseUsdc`. */
  graduationUsdc: number;
  weights: number[];
  /** Where each segment ends and how deep it is relative to the deepest. */
  segments: Array<{ upToUsd: number; relativeDepth: number }>;
  /** What to hand to DBC's `createConfig`, minus the accounts. */
  config: ConfigParameters;
  /** The plan in sentences, for the person who has to approve it. */
  explanation: string[];
}

const DECIMALS = TokenDecimal.SIX;

function bell(concentration: number): number[] {
  const centre = (CURVE_SEGMENTS - 1) / 2;
  return Array.from({ length: CURVE_SEGMENTS }, (_, i) => {
    const x = ((i - centre) / (CURVE_SEGMENTS / 4)) * concentration;
    // A floor under the tails: a segment with no liquidity is a cliff, not a curve.
    return Number((0.4 + 4 * Math.exp(-x * x)).toFixed(4));
  });
}

export function planStockLaunch(raw: StockLaunchInput): StockLaunchPlan {
  const input = {
    concentration: 1,
    startingFeeBps: 100,
    endingFeeBps: 25,
    feeDecaySeconds: 600,
    graduatedPoolFeeBps: 25,
    lockedLiquidityPercent: 100,
    tokenType: TokenType.SPLToken,
    ...raw,
  };
  const finite = (value: number, name: string) => {
    if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  };
  finite(input.referenceUsd, "referenceUsd");
  finite(input.bandBps, "bandBps");
  finite(input.raiseUsdc, "raiseUsdc");
  if (input.referenceUsd <= 0) throw new Error("referenceUsd must be positive: a curve cannot be anchored to a price that is not one");
  if (input.bandBps < 25 || input.bandBps > 5_000) throw new Error("bandBps must be between 25 and 5000");
  if (input.raiseUsdc < 100) throw new Error("raiseUsdc must be at least 100");
  if (input.concentration < 0 || input.concentration > 4) throw new Error("concentration must be between 0 and 4");
  if (input.endingFeeBps < 25 || input.startingFeeBps < input.endingFeeBps || input.startingFeeBps > 9_900) {
    throw new Error("fees must satisfy 25 <= endingFeeBps <= startingFeeBps <= 9900");
  }
  if (input.lockedLiquidityPercent < 10 || input.lockedLiquidityPercent > 100) throw new Error("lockedLiquidityPercent must be between 10 and 100");

  const opening = input.referenceUsd * (1 - input.bandBps / 10_000);
  const graduation = input.referenceUsd * (1 + input.bandBps / 10_000);
  // Inside a narrow band roughly half the supply sells on the curve and half
  // seeds the pool it graduates into, so the raise is about half the supply at
  // the reference price. The builder's own figure is reported back below.
  const leftoverShare = 0.02;
  const selling = Math.max(1, Math.ceil((2 * input.raiseUsdc) / input.referenceUsd));
  const leftover = Math.max(1, Math.ceil(selling * leftoverShare));
  const totalSupply = selling + leftover;
  const weights = bell(input.concentration);

  const config = buildCurveWithLiquidityWeights({
    token: {
      tokenType: input.tokenType,
      tokenBaseDecimal: DECIMALS,
      tokenQuoteDecimal: DECIMALS,
      // Immutable: no one can mint more or repoint the metadata afterwards. A
      // real issuer needs a mint authority for corporate actions; a launch that
      // only claims to track a price should not have one to abuse.
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: totalSupply,
      leftover,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: input.startingFeeBps,
          endingFeeBps: input.endingFeeBps,
          numberOfPeriod: input.startingFeeBps === input.endingFeeBps ? 0 : 10,
          totalDuration: input.startingFeeBps === input.endingFeeBps ? 0 : input.feeDecaySeconds,
        },
      },
      // Volatility pays the pool rather than whoever caused it.
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Enabled,
        poolFeeBps: input.graduatedPoolFeeBps,
      },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: input.lockedLiquidityPercent,
      partnerLiquidityPercentage: 100 - input.lockedLiquidityPercent,
      creatorPermanentLockedLiquidityPercentage: 0,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    initialMarketCap: opening * totalSupply,
    migrationMarketCap: graduation * totalSupply,
    liquidityWeights: weights,
  } as Parameters<typeof buildCurveWithLiquidityWeights>[0]);

  const usd = (sqrtPrice: ConfigParameters["sqrtStartPrice"]) => Number(getPriceFromSqrtPrice(sqrtPrice, DECIMALS, DECIMALS).toString());
  const deepest = Math.max(...weights);
  const segments = config.curve.map((point, i) => ({
    upToUsd: usd(point.sqrtPrice),
    relativeDepth: Number(((weights[i] ?? 0) / deepest).toFixed(3)),
  }));
  const graduationUsdc = Number(config.migrationQuoteThreshold.toString()) / 1e6;
  const openingPriceUsd = usd(config.sqrtStartPrice);
  const graduationPriceUsd = segments[segments.length - 1]?.upToUsd ?? graduation;
  const edgeDepth = Math.round((Math.min(...weights) / deepest) * 100);

  return {
    input,
    totalSupply,
    leftover,
    openingPriceUsd,
    graduationPriceUsd,
    graduationUsdc,
    weights,
    segments,
    config,
    explanation: [
      `Anchored to $${input.referenceUsd.toFixed(2)}, observed independently of this pool.`,
      `Opens at $${openingPriceUsd.toFixed(2)} and graduates at $${graduationPriceUsd.toFixed(2)}: the whole curve sits within ${input.bandBps} bps of the reference, so there is no run from zero to be first in.`,
      input.concentration === 0
        ? "Depth is spread evenly across the band."
        : `Depth peaks at the reference and falls to ${edgeDepth}% of that at the edges, so trading near fair value moves the price least and each step away from it costs more.`,
      `${totalSupply} tokens in all, one token to one share of exposure. About half sell along the curve; the rest seed the pool it graduates into. ${leftover} are held back for rounding and return to the issuer.`,
      `Graduates after ${graduationUsdc.toFixed(2)} USDC, into a DAMM v2 pool charging ${input.graduatedPoolFeeBps} bps with ${input.lockedLiquidityPercent}% of its liquidity locked for good.`,
      input.startingFeeBps === input.endingFeeBps
        ? `A flat ${input.endingFeeBps} bps fee, in USDC.`
        : `The fee starts at ${input.startingFeeBps} bps and falls to ${input.endingFeeBps} over ${Math.round(input.feeDecaySeconds / 60)} minutes, in USDC. Being first costs more, not less.`,
      "The mint is immutable: no further supply and no change of metadata after launch.",
    ],
  };
}

/** How far a pool's price sits from the reference it was anchored to, in bps. */
export function premiumBps(poolPriceUsd: number, referenceUsd: number): number {
  return Math.round(((poolPriceUsd - referenceUsd) / referenceUsd) * 10_000);
}

// ------------------------------------------------------------- after launch

/**
 * What an issuer needs to know about a curve once it is live.
 *
 * A curve anchored to a price is only anchored on the day it launches. The share
 * keeps moving and the curve's range does not, so the question worth a monitor
 * is whether fair value is still somewhere the curve can reach:
 *
 *   tracking               the share is inside the curve's range and buyers have
 *                          moved the pool off its opening price; buying moves
 *                          it toward the share and the band means what it said
 *   at-opening             the share is inside the range, but the pool is still
 *                          where it opened: almost nothing has been bought, so
 *                          its gap to the share is the launch's opening discount
 *                          plus the share's move since, not a price anyone paid
 *   reference-above-range  the share has risen past the graduation price, so
 *                          every token left on the curve is cheap. It will be
 *                          bought out and graduate at a discount to the share
 *   reference-below-range  the share has fallen under the opening price, so
 *                          every token on the curve is dear. Nobody rational
 *                          buys, and the curve is stranded above fair value
 *   graduated              the curve is finished; its liquidity is a DAMM v2 pool
 *
 * The two out-of-range states are the ones to act on: they are when an issuer
 * would retire the curve and launch one around the new price.
 */
export type CurveHealth = "tracking" | "at-opening" | "reference-above-range" | "reference-below-range" | "graduated";

/**
 * How little of its range a pool may have climbed and still be where it opened.
 * One percent of a 600 bps range is about 6 bps of price, less than one buyer's
 * fee: nothing a market decided.
 */
export const AT_OPENING_RANGE = 0.01;

export interface CurveObservation {
  openingPriceUsd: number;
  graduationPriceUsd: number;
  /** The reference the curve was planned around, on the day. */
  anchoredToUsd: number;
  graduated: boolean;
  /** The pool's spot price now. Absent once graduated, or if it could not be read. */
  poolPriceUsd?: number;
  /** The share's price now, from sources that have never heard of this pool. */
  referenceUsd?: number;
}

export interface CurveAssessment {
  /** Absent when there is no live reference: a monitor with nothing to compare against says so. */
  health?: CurveHealth;
  /** The pool against the live share: what a buyer pays over or under fair value. */
  premiumBps?: number;
  /** The live share against the anchor: how far the world has moved since launch. */
  referenceDriftBps?: number;
  /** How much of the curve's price range the pool has climbed, 0..1. */
  rangePosition?: number;
  summary: string;
}

export function assessCurve(seen: CurveObservation): CurveAssessment {
  const { openingPriceUsd: open, graduationPriceUsd: top, referenceUsd: reference, poolPriceUsd: pool } = seen;
  if (!(open > 0) || !(top > open)) throw new Error("a curve's range must run upward from a positive opening price");
  const usable = (value?: number): value is number => value !== undefined && Number.isFinite(value) && value > 0;
  const premium = usable(pool) && usable(reference) ? premiumBps(pool, reference) : undefined;
  const drift = usable(reference) ? premiumBps(reference, seen.anchoredToUsd) : undefined;
  const position = usable(pool) ? Math.min(1, Math.max(0, (pool - open) / (top - open))) : undefined;
  const measured = { premiumBps: premium, referenceDriftBps: drift, rangePosition: position === undefined ? undefined : Number(position.toFixed(4)) };

  if (seen.graduated) {
    return { ...measured, health: "graduated", summary: "The curve has graduated; its liquidity is a DAMM v2 pool and the curve no longer fills." };
  }
  if (!usable(reference)) {
    return { ...measured, summary: "No live reference price, so the curve cannot be compared with the share it was anchored to." };
  }
  const range = `$${open.toFixed(2)} to $${top.toFixed(2)}`;
  if (reference > top) {
    return { ...measured, health: "reference-above-range", summary: `The share is at $${reference.toFixed(2)}, above the curve's range of ${range}. Everything left on the curve is cheap: expect it to be bought out and to graduate at a discount. Consider retiring it for a curve around the new price.` };
  }
  if (reference < open) {
    return { ...measured, health: "reference-below-range", summary: `The share is at $${reference.toFixed(2)}, below the curve's range of ${range}. Everything on the curve is dear, so it is stranded above fair value. Consider retiring it for a curve around the new price.` };
  }
  // Inside the range, but nobody has moved the pool: its price is still the
  // launch's, and calling that "tracking" would credit a market that has not traded.
  if (usable(pool) && premium !== undefined && drift !== undefined && (pool - open) / (top - open) < AT_OPENING_RANGE) {
    const where = pool.toFixed(2) === open.toFixed(2)
      ? `The pool is still at its opening price of $${open.toFixed(2)}`
      : `The pool has barely moved off its opening price: $${pool.toFixed(2)}, against $${open.toFixed(2)} at launch`;
    return { ...measured, health: "at-opening", summary: `${where}, ${Math.abs(premium)} bps ${premium <= 0 ? "under" : "over"} the share at $${reference.toFixed(2)}. That gap is the curve's opening discount plus the share's move since launch (${drift > 0 ? "+" : ""}${drift} bps), not a price a market has set: the curve is waiting for buyers.` };
  }
  return { ...measured, health: "tracking", summary: `The share is at $${reference.toFixed(2)}, inside the curve's range of ${range}${premium === undefined ? "" : `; the pool sits ${premium} bps from it`}.` };
}
