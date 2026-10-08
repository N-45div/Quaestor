/**
 * A launched curve as the hub serves it, and a watcher for one it does not trade.
 *
 * The devnet curve is read by the price tick every twenty seconds, because the
 * gate prices its trades off it. Nothing trades the mainnet curve here, so it
 * is read on a slow timer of its own: the pool account every few minutes, for
 * its price, how far it has to run and the fees it has taken, and its
 * transactions only when the pool has moved since they were last read. A public
 * request reads what the timer last saw and never the chain, so however often
 * the curves route is polled, the RPC is asked the same.
 *
 * Nothing here signs or holds a key. The one thing it needs is an RPC.
 */
import { assessCurve } from "./dbc-launch";
import { DBC_VENUE, type DbcPoolSighting, type DbcPoolState, type DbcTrade } from "./dbc-venue";
import type { StockCurveActivityView, StockCurveFeesView, StockCurveView } from "./platform";

/** What a curve was launched with, as its deployment file records it. None of it changes. */
export interface LaunchedCurve {
  cluster: StockCurveView["cluster"];
  pool: string;
  baseMint: string;
  symbol: string;
  anchoredToUsd: number;
  bandBps: number;
  openingPriceUsd: number;
  graduationPriceUsd: number;
  graduationUsdc: number;
}

/**
 * The curve as its issuer would watch it, from what was last seen of the pool
 * and the share's price now. Every curve the hub serves goes through this, so
 * a devnet curve and a mainnet one are judged by the same rules.
 */
export function curveView(
  curve: LaunchedCurve,
  seen: DbcPoolSighting | undefined,
  referenceUsd: number | undefined,
  extra: Pick<StockCurveView, "fees" | "activity"> = {},
): StockCurveView {
  const judged = assessCurve({
    openingPriceUsd: curve.openingPriceUsd,
    graduationPriceUsd: curve.graduationPriceUsd,
    anchoredToUsd: curve.anchoredToUsd,
    graduated: seen?.graduated ?? false,
    poolPriceUsd: seen?.priceUsd,
    referenceUsd,
  });
  return {
    cluster: curve.cluster,
    venue: DBC_VENUE,
    pool: curve.pool,
    instrument_mint: curve.baseMint,
    symbol: curve.symbol,
    anchored_to_usd: curve.anchoredToUsd,
    band_bps: curve.bandBps,
    opening_price_usd: curve.openingPriceUsd,
    graduation_price_usd: curve.graduationPriceUsd,
    graduation_usdc: curve.graduationUsdc,
    observed_at: seen ? new Date(seen.observedAt * 1000).toISOString() : undefined,
    graduated: seen?.graduated,
    pool_price_usd: seen?.priceUsd === undefined ? undefined : Number(seen.priceUsd.toFixed(6)),
    progress: seen?.progress === undefined ? undefined : Number(seen.progress.toFixed(6)),
    raised_usdc: seen?.progress === undefined ? undefined : Number((seen.progress * curve.graduationUsdc).toFixed(2)),
    reference_price_usd: referenceUsd,
    // No sighting yet is not "tracking": the pool has not been read, so nothing is claimed.
    health: seen ? judged.health : undefined,
    premium_bps: judged.premiumBps,
    reference_drift_bps: judged.referenceDriftBps,
    range_position: judged.rangePosition,
    ...(seen?.graduatedInto ? { graduated_into: seen.graduatedInto } : {}),
    ...extra,
    summary: seen ? judged.summary : "The pool has not been read yet; the first read is still to come.",
  };
}

// ---------------------------------------------------------------- the watcher

/** A curve as the watcher needs it. An interface, so a test can hand it a pool that moves on demand. */
export interface DbcWatchedPool {
  state(): Promise<DbcPoolState>;
  tradesSince(cursor: string | undefined, limit: number): Promise<{ trades: DbcTrade[]; cursor: string | undefined; more: boolean }>;
}

export interface DbcCurveWatcherConfig {
  curve: LaunchedCurve;
  pool: DbcWatchedPool;
  /** How often the pool account is read. */
  everyMs?: number;
  /** The least time between two reads of its transactions, which also wait for the pool to move. */
  activityEveryMs?: number;
  /** Transactions read in one pass, at most. */
  transactionsPerPass?: number;
  onError?: (error: unknown) => void;
  now?: () => number;
}

const usdc = (raw: bigint): number => Number((Number(raw) / 1e6).toFixed(6));

export class DbcCurveWatcher {
  private readonly now: () => number;
  private seen: DbcPoolSighting | undefined;
  private fees: StockCurveFeesView | undefined;
  private opensAt: number | undefined;
  private readonly tally = { trades: 0, buys: 0, sells: 0, firstMinute: 0, bought: 0n, sold: 0n, firstAt: undefined as number | undefined, lastAt: undefined as number | undefined };
  private cursor: string | undefined;
  private backlog = false;
  private activityAt: number | undefined;
  private activityMark: string | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly cfg: DbcCurveWatcherConfig) {
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Read now, then on the timer. The timer does not hold the process open. */
  start(): this {
    void this.tick();
    const timer = setInterval(() => void this.tick(), this.cfg.everyMs ?? 300_000);
    timer.unref?.();
    return this;
  }

  /**
   * One pass: the pool account, then its transactions if the pool has moved
   * since they were last read, a backlog is left, or they never were. Never
   * throws: a failed read keeps what was last seen, and its age says so. Passes
   * do not overlap, so a slow RPC delays the next one rather than doubling it.
   */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async pass(): Promise<void> {
    let state: DbcPoolState;
    try {
      state = await this.cfg.pool.state();
    } catch (error) {
      this.cfg.onError?.(error);
      return;
    }
    const t = this.now();
    this.seen = state.graduated
      ? { observedAt: t, graduated: true }
      : { observedAt: t, graduated: false, priceUsd: state.priceUsd, progress: state.progress };
    this.fees = { earned_usdc: usdc(state.tradingFees), unclaimed_usdc: usdc(state.unclaimedFees), protocol_usdc: usdc(state.protocolFees) };
    this.opensAt = state.opensAt;

    // Every swap pays a fee and moves the reserve, so counters that have not
    // changed mean no new trades, and the transactions are not asked for.
    const mark = `${state.tradingFees}:${state.protocolFees}:${state.progress}:${state.graduated}`;
    const due = this.activityAt === undefined
      || this.backlog
      || (mark !== this.activityMark && (t - this.activityAt) * 1000 >= (this.cfg.activityEveryMs ?? 1_800_000));
    if (!due) return;
    try {
      const read = await this.cfg.pool.tradesSince(this.cursor, this.cfg.transactionsPerPass ?? 25);
      for (const trade of read.trades) this.count(trade);
      this.cursor = read.cursor;
      this.backlog = read.more;
      this.activityAt = t;
      this.activityMark = mark;
    } catch (error) {
      this.cfg.onError?.(error);
    }
  }

  private count(trade: DbcTrade): void {
    const tally = this.tally;
    tally.trades += 1;
    if (trade.side === "buy") { tally.buys += 1; tally.bought += trade.usdc; } else { tally.sells += 1; tally.sold += trade.usdc; }
    tally.firstAt ??= trade.at;
    tally.lastAt = trade.at;
    if (this.opensAt !== undefined && trade.at >= this.opensAt && trade.at - this.opensAt < 60) tally.firstMinute += 1;
  }

  /** The curve as the hub serves it: what the timer last saw, never the chain. */
  monitor(referenceUsd: number | undefined): StockCurveView {
    return curveView(this.cfg.curve, this.seen, referenceUsd, { fees: this.fees, activity: this.activity() });
  }

  private activity(): StockCurveActivityView | undefined {
    if (this.activityAt === undefined) return undefined;
    const iso = (t: number | undefined) => (t === undefined ? undefined : new Date(t * 1000).toISOString());
    const tally = this.tally;
    return {
      trades: tally.trades,
      buys: tally.buys,
      sells: tally.sells,
      opened_at: iso(this.opensAt),
      first_trade_at: iso(tally.firstAt),
      last_trade_at: iso(tally.lastAt),
      in_first_minute: this.opensAt === undefined ? undefined : tally.firstMinute,
      bought_usdc: usdc(tally.bought),
      sold_usdc: usdc(tally.sold),
      observed_at: new Date(this.activityAt * 1000).toISOString(),
    };
  }
}
