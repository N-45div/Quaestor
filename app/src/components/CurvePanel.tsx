import { useEffect, useState } from "react";
import { AlertTriangle, ArrowUpRight, CheckCircle2, Flag, Hourglass, ShieldQuestion } from "lucide-react";
import { fetchCurves, shortMint, type CurveView } from "../lib/stocks";

const HEALTH: Record<NonNullable<CurveView["health"]>, { label: string; tone: "ok" | "no" | "wait" }> = {
  tracking: { label: "Share inside the range", tone: "ok" },
  "at-opening": { label: "Waiting for buyers", tone: "wait" },
  "reference-above-range": { label: "Share above the range", tone: "no" },
  "reference-below-range": { label: "Share below the range", tone: "no" },
  graduated: { label: "Graduated", tone: "wait" },
};

function Health({ curve }: { curve: CurveView | null }) {
  const health = curve?.health ? HEALTH[curve.health] : undefined;
  if (!health) return <span className="pg-verdict pg-verdict-wait"><ShieldQuestion size={15} />Reading the pool</span>;
  const Icon = health.tone === "ok" ? CheckCircle2 : health.tone === "no" ? AlertTriangle : curve?.health === "at-opening" ? Hourglass : Flag;
  return <span className={`pg-verdict pg-verdict-${health.tone}`}><Icon size={15} />{health.label}</span>;
}

/**
 * The curve's price range as a track, with the pool and the live share on it.
 *
 * The track runs a little past both ends so a share that has left the range is
 * still drawn where it is; past that it is pinned to the edge and says so. The
 * marks carry identity by colour and shape, the labels stay in text colour.
 */
function RangeTrack({ curve }: { curve: CurveView }) {
  const open = curve.opening_price_usd;
  const top = curve.graduation_price_usd;
  const pad = (top - open) * 0.3;
  const low = open - pad;
  const span = top + pad - low;
  const at = (price: number) => Math.min(100, Math.max(0, ((price - low) / span) * 100));
  const pinned = (price: number) => price < low || price > top + pad;
  const pool = curve.pool_price_usd;
  const share = curve.reference_price_usd;

  return <div className="cv-track-wrap">
    <div className="cv-legend">
      <span><i className="cv-mark cv-mark-pool" />Pool price</span>
      <span><i className="cv-mark cv-mark-share" />Share price now</span>
      <span><i className="cv-mark cv-mark-anchor" />Anchored at launch</span>
    </div>
    <div className="cv-track" role="img"
      aria-label={`Curve range $${open.toFixed(2)} to $${top.toFixed(2)}. Pool ${pool === undefined ? "unread" : `$${pool.toFixed(2)}`}, share ${share === undefined ? "unknown" : `$${share.toFixed(2)}`}.`}>
      <div className="cv-range" style={{ left: `${at(open)}%`, width: `${at(top) - at(open)}%` }} />
      <i className="cv-pin cv-pin-anchor" style={{ left: `${at(curve.anchored_to_usd)}%` }} title={`Anchored at $${curve.anchored_to_usd.toFixed(2)} when it launched`} />
      {share === undefined ? null
        : <i className="cv-pin cv-pin-share" style={{ left: `${at(share)}%` }} title={`Share $${share.toFixed(2)}${pinned(share) ? " (off the scale)" : ""}`} />}
      {pool === undefined ? null
        : <i className="cv-pin cv-pin-pool" style={{ left: `${at(pool)}%` }} title={`Pool $${pool.toFixed(4)}`} />}
    </div>
    <div className="cv-ends">
      <span style={{ left: `${at(open)}%` }}>${open.toFixed(2)}<small>opens</small></span>
      <span style={{ left: `${at(top)}%` }}>${top.toFixed(2)}<small>graduates</small></span>
    </div>
  </div>;
}

const money = (usdc: number) => `$${usdc.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const utc = (iso: string) => `${new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
const seconds = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 1000);

/**
 * What the mainnet launch has seen: the fees it has taken and who traded it.
 * Only a watched curve carries these; the devnet one is read by the price tick
 * and its trades are the governor's, listed on their own page.
 */
function LaunchTiles({ curve }: { curve: CurveView }) {
  const { fees, activity } = curve;
  if (!fees && !activity) return null;
  return <div className="st-tiles">
    <div>
      <span>Fees earned</span>
      <strong>{fees ? money(fees.earned_usdc) : "—"}</strong>
      <small>{fees ? `USDC to the launch, ${money(fees.unclaimed_usdc)} unclaimed · Meteora took ${money(fees.protocol_usdc)}` : "pool not read yet"}</small>
    </div>
    <div>
      <span>Trades</span>
      <strong>{activity ? activity.trades : "—"}</strong>
      <small>{activity
        ? activity.trades === 0 ? "nobody has traded it yet" : `${activity.buys} buys, ${activity.sells} sells · ${money(activity.bought_usdc)} in, ${money(activity.sold_usdc)} out · last ${activity.last_trade_at ? utc(activity.last_trade_at) : "—"}`
        : "transactions not read yet"}</small>
    </div>
    <div>
      <span>In the first minute</span>
      <strong>{activity?.in_first_minute ?? "—"}</strong>
      <small>{activity?.opened_at && activity.first_trade_at
        ? `the first landed ${seconds(activity.opened_at, activity.first_trade_at)} s after the pool opened, when its fee is at its highest`
        : "trades within 60 s of the pool opening"}</small>
    </div>
  </div>;
}

/**
 * A launched curve, as its issuer would watch it. The sentence at the top is
 * the hub's own, the same one an agent or a script reads from /v1/stocks/curves.
 */
function CurveCard({ curve }: { curve: CurveView | null }) {
  const premium = curve?.premium_bps;
  const drift = curve?.reference_drift_bps;
  const mainnet = curve?.cluster === "mainnet";

  return <section className="st-price cv">
    <div className="st-price-head">
      <div>
        <h2>{curve ? <>{curve.symbol} curve <span className={`st-chip ${mainnet ? "st-chip-live" : "st-chip-muted"}`}>{mainnet ? "mainnet" : "devnet"}</span></> : "The curve"}</h2>
        <p>{curve
          ? <>Meteora DBC · pool <a className="mono-link" href={`https://explorer.solana.com/address/${curve.pool}${mainnet ? "" : "?cluster=devnet"}`} target="_blank" rel="noreferrer">{shortMint(curve.pool)}<ArrowUpRight size={12} /></a> · launched {curve.band_bps} bps either side of ${curve.anchored_to_usd.toFixed(2)}{mainnet ? " · watched, never traded by the hub" : ""}</>
          : "Reading the curve"}</p>
      </div>
      <Health curve={curve} />
    </div>
    {curve ? <>
      <p className="st-narrative">
        A curve is anchored on the day it launches and the share keeps moving, so the thing to watch is
        whether fair value is still somewhere the curve can reach. {curve.summary}
      </p>
      <div className="st-tiles">
        <div>
          <span>Pool price</span>
          <strong>{curve.pool_price_usd === undefined ? "—" : `$${curve.pool_price_usd.toFixed(2)}`}</strong>
          <small>{premium === undefined ? "needs the share's price too" : `${premium > 0 ? "+" : ""}${premium} bps from the share`}</small>
        </div>
        <div>
          <span>To graduation</span>
          <strong>{curve.progress === undefined ? "—" : `${(curve.progress * 100).toFixed(2)}%`}</strong>
          <small>{curve.raised_usdc === undefined
            ? "pool not read yet"
            : `${curve.raised_usdc.toLocaleString("en-US")} of ${Math.round(curve.graduation_usdc).toLocaleString("en-US")} USDC, then a DAMM v2 pool`}</small>
        </div>
        <div>
          <span>Share since launch</span>
          <strong>{drift === undefined ? "—" : `${drift > 0 ? "+" : ""}${drift} bps`}</strong>
          <small>the range does not move with it: past ±{curve.band_bps} bps the curve is out of reach</small>
        </div>
      </div>
      <LaunchTiles curve={curve} />
      <RangeTrack curve={curve} />
    </> : null}
  </section>;
}

/** Every curve the hub serves, refreshed on the hub's own clock. Null until the first answer, and on failure. */
function useCurves(base: string): { curves: CurveView[] | null; failure: string | null } {
  const [curves, setCurves] = useState<CurveView[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => fetchCurves(base)
      .then((all) => { if (live) { setCurves(all); setFailure(null); } })
      .catch((e) => { if (live) setFailure((e as Error).message); });
    setCurves(null);
    void load();
    // The hub reads the devnet pool every 20s and the mainnet one every 5 min; asking faster re-reads the same sighting.
    const timer = setInterval(load, 20_000);
    return () => { live = false; clearInterval(timer); };
  }, [base]);

  return { curves, failure };
}

/** One curve, by its token: the Stocks view's panel for the instrument in focus. */
export function CurvePanel({ base, mint }: { base: string; mint: string }) {
  const { curves, failure } = useCurves(base);
  const curve = curves?.find((c) => c.instrument_mint === mint) ?? null;
  if (failure && !curve) return null;
  return <CurveCard curve={curve} />;
}

/**
 * Both curves, mainnet first: the launch real money can reach, then the one the
 * governor trades. Hidden when the hub is asleep or serves none, so the page
 * around it never waits on it.
 */
export function CurvePanels({ base }: { base: string }) {
  const { curves } = useCurves(base);
  if (!curves?.length) return null;
  const ordered = [...curves].sort((a, b) => (a.cluster === "mainnet" ? 0 : 1) - (b.cluster === "mainnet" ? 0 : 1));
  return <section className="data-section">
    <div className="section-heading">
      <div><span className="eyebrow">LAUNCH CURVES</span><h2>Anchored to the share, watched against it</h2></div>
      <span className="row-count">{curves.length === 1 ? "1 curve" : `${curves.length} curves`} · read by the hub</span>
    </div>
    {ordered.map((curve) => <CurveCard key={`${curve.cluster ?? "devnet"}:${curve.pool}`} curve={curve} />)}
  </section>;
}
