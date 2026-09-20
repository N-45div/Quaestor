import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Flag, ShieldQuestion } from "lucide-react";
import { fetchCurves, shortMint, type CurveView } from "../lib/stocks";

const HEALTH: Record<NonNullable<CurveView["health"]>, { label: string; tone: "ok" | "no" | "wait" }> = {
  tracking: { label: "Share inside the range", tone: "ok" },
  "reference-above-range": { label: "Share above the range", tone: "no" },
  "reference-below-range": { label: "Share below the range", tone: "no" },
  graduated: { label: "Graduated", tone: "wait" },
};

function Health({ curve }: { curve: CurveView | null }) {
  const health = curve?.health ? HEALTH[curve.health] : undefined;
  if (!health) return <span className="pg-verdict pg-verdict-wait"><ShieldQuestion size={15} />Reading the pool</span>;
  const Icon = health.tone === "ok" ? CheckCircle2 : health.tone === "no" ? AlertTriangle : Flag;
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

/**
 * A launched curve, as its issuer would watch it. The sentence at the top is
 * the hub's own, the same one an agent or a script reads from /v1/stocks/curves.
 */
export function CurvePanel({ base, mint }: { base: string; mint: string }) {
  const [curve, setCurve] = useState<CurveView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => fetchCurves(base)
      .then((curves) => { if (live) { setCurve(curves.find((c) => c.instrument_mint === mint) ?? null); setFailure(null); } })
      .catch((e) => { if (live) setFailure((e as Error).message); });
    setCurve(null);
    void load();
    // The hub reads the pool every 20s; asking faster re-reads the same sighting.
    const timer = setInterval(load, 20_000);
    return () => { live = false; clearInterval(timer); };
  }, [base, mint]);

  if (failure && !curve) return null;
  const premium = curve?.premium_bps;
  const drift = curve?.reference_drift_bps;

  return <section className="st-price cv">
    <div className="st-price-head">
      <div>
        <h2>The curve</h2>
        <p>{curve
          ? `Meteora DBC · pool ${shortMint(curve.pool)} · launched ${curve.band_bps} bps either side of $${curve.anchored_to_usd.toFixed(2)}`
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
      <RangeTrack curve={curve} />
    </> : null}
  </section>;
}
