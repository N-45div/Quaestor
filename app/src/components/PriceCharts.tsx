import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { PriceBucketView, PriceSummaryView } from "../lib/stocks";

/**
 * Two charts, one axis each: price (token vs its underlying's reference, both in
 * USD) and premium (their gap, in basis points around zero). They are separate
 * on purpose — the gap is two orders of magnitude smaller than the price, so on
 * a shared axis it would be invisible, and a second y-axis would be the worse
 * lie. They share one hover position so a reader reads both at the same moment.
 *
 * The two price lines nearly overlap by design, so end-of-line labels would
 * collide; identity comes from the legend and the tooltip instead.
 */

const M = { top: 14, right: 18, bottom: 26, left: 66 };
const PRICE_H = 220;
const PREMIUM_H = 150;

const fmtUsd = (v: number) => `$${v.toFixed(2)}`;
const fmtBps = (v: number) => `${v > 0 ? "+" : ""}${v} bps`;
const fmtTime = (t: number) =>
  new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function useWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Round-number ticks inside [lo, hi] — steps of 1, 2 or 5 × 10^k. Zero is a
 * multiple of every step, so any domain that contains zero gets a zero tick.
 */
function ticks(lo: number, hi: number, count: number): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  // Round to the nearest nice step rather than up to it, so a range gets four
  // or five ticks instead of collapsing to two.
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** A line broken wherever the series has no value, rather than drawn across the gap. */
function linePath(data: PriceBucketView[], key: "tokenized" | "reference", x: (i: number) => number, y: (v: number) => number) {
  let d = "";
  let pen = false;
  data.forEach((b, i) => {
    const v = b[key];
    if (v === undefined) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

/** A column from the baseline to its value: square at the baseline, 4px round at the data end. */
function barPath(cx: number, w: number, y0: number, y1: number): string {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const h = Math.abs(y1 - y0);
  const r = Math.min(4, w / 2, h);
  if (h < 0.5) return "";
  if (y1 < y0) {
    // Upward: round the top.
    return `M${x0},${y0}V${y1 + r}Q${x0},${y1} ${x0 + r},${y1}H${x1 - r}Q${x1},${y1} ${x1},${y1 + r}V${y0}Z`;
  }
  return `M${x0},${y0}V${y1 - r}Q${x0},${y1} ${x0 + r},${y1}H${x1 - r}Q${x1},${y1} ${x1},${y1 - r}V${y0}Z`;
}

export function PriceCharts({ summary }: { summary: PriceSummaryView }) {
  const [ref, measured] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const data = summary.series;
  const n = data.length;

  const width = Math.max(measured, 300);
  const innerW = width - M.left - M.right;
  // Each bucket owns an equal slot and its mark sits in the middle of it — the
  // same mapping in both charts, so bars stay inside the plot and the shared
  // crosshair lands on the same moment in each.
  const slot = n > 0 ? innerW / n : innerW;
  const x = (i: number) => M.left + (i + 0.5) * slot;

  // ---- price domain, padded so a flat line is not drawn on the frame
  const prices = data.flatMap((b) => [b.tokenized, b.reference]).filter((v): v is number => v !== undefined);
  const pLo = prices.length ? Math.min(...prices) : 0;
  const pHi = prices.length ? Math.max(...prices) : 1;
  const pad = (pHi - pLo || pHi * 0.001 || 1) * 0.15;
  const [yLo, yHi] = [pLo - pad, pHi + pad];
  const priceInnerH = PRICE_H - M.top - M.bottom;
  const yPrice = (v: number) => M.top + (1 - (v - yLo) / (yHi - yLo)) * priceInnerH;

  // ---- premium domain always contains zero, so the baseline is real
  const premiums = data.map((b) => b.premium_bps).filter((v): v is number => v !== undefined);
  const bLo = Math.min(0, ...premiums);
  const bHi = Math.max(0, ...premiums);
  const bPad = Math.max(5, (bHi - bLo) * 0.15);
  const [zLo, zHi] = [bLo - bPad, bHi + bPad];
  const premInnerH = PREMIUM_H - M.top - M.bottom;
  const yPrem = (v: number) => M.top + (1 - (v - zLo) / (zHi - zLo)) * premInnerH;
  const barW = Math.max(2, Math.min(24, slot - 2));

  const pick = (clientX: number, rect: DOMRect) => {
    if (n === 0) return;
    setHover(Math.max(0, Math.min(n - 1, Math.floor((clientX - rect.left - M.left) / slot))));
  };
  const onMove = (e: PointerEvent<SVGRectElement>) => pick(e.clientX, (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect());
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setHover((h) => Math.max(0, Math.min(n - 1, (h ?? n - 1) + (e.key === "ArrowLeft" ? -1 : 1))));
  };

  const active = hover !== null ? data[hover] : undefined;
  const xTicks = n > 1 ? [0, Math.floor((n - 1) / 3), Math.floor((2 * (n - 1)) / 3), n - 1] : [0];
  const hasPrices = prices.length > 0;
  const hasTokenized = data.some((b) => b.tokenized !== undefined);
  const hasPremium = premiums.length > 0;

  if (!hasPrices) {
    return <div className="pc-empty">No live prices for {summary.instrument.symbol} yet. The hub samples listed stocks against Backpack and Jupiter; history appears as soon as the first tick lands.</div>;
  }

  return <div className="pc" ref={ref} tabIndex={0} onKeyDown={onKey} aria-label={`Price and premium charts for ${summary.instrument.symbol}. Use the arrow keys to move through time.`}>
    <div className="pc-legend" aria-hidden="true">
      {/* One series needs no key for a second: a devnet test mint has no market
          of its own, and a legend entry for a line that is not there is a lie. */}
      {hasTokenized ? <span><i className="pc-key pc-key-1" />{summary.instrument.symbol} · token</span> : null}
      <span><i className="pc-key pc-key-2" />{summary.instrument.underlying ?? "underlying"} · reference</span>
    </div>

    {/* ---------------- price */}
    <svg className="pc-svg" width={width} height={PRICE_H} role="img" aria-label={`${summary.instrument.symbol} price against its reference`}>
      {ticks(yLo, yHi, 4).map((v) => <g key={v}>
        <line className="pc-grid" x1={M.left} x2={width - M.right} y1={yPrice(v)} y2={yPrice(v)} />
        <text className="pc-axis" x={M.left - 8} y={yPrice(v)} textAnchor="end" dominantBaseline="middle">{fmtUsd(v)}</text>
      </g>)}
      {xTicks.map((i) => <text key={i} className="pc-axis" x={x(i)} y={PRICE_H - 8} textAnchor="middle">{fmtTime(data[i].t)}</text>)}
      <path className="pc-line pc-line-2" d={linePath(data, "reference", x, yPrice)} />
      <path className="pc-line pc-line-1" d={linePath(data, "tokenized", x, yPrice)} />
      {active && hover !== null ? <g>
        <line className="pc-cross" x1={x(hover)} x2={x(hover)} y1={M.top} y2={PRICE_H - M.bottom} />
        {active.reference !== undefined ? <circle className="pc-dot pc-dot-2" cx={x(hover)} cy={yPrice(active.reference)} r={4} /> : null}
        {active.tokenized !== undefined ? <circle className="pc-dot pc-dot-1" cx={x(hover)} cy={yPrice(active.tokenized)} r={4} /> : null}
      </g> : null}
      <rect className="pc-hit" x={M.left} y={M.top} width={innerW} height={priceInnerH} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
    </svg>

    {/* ---------------- premium: only when there are two sides to compare */}
    {hasPremium ? <><div className="pc-subtitle">Premium of the token over its reference</div>
    <svg className="pc-svg" width={width} height={PREMIUM_H} role="img" aria-label={`${summary.instrument.symbol} premium over its reference in basis points`}>
      {ticks(zLo, zHi, 4).map((v) => <g key={v}>
        <line className="pc-grid" x1={M.left} x2={width - M.right} y1={yPrem(v)} y2={yPrem(v)} />
        <text className="pc-axis" x={M.left - 8} y={yPrem(v)} textAnchor="end" dominantBaseline="middle">{fmtBps(Math.round(v))}</text>
      </g>)}
      <line className="pc-zero" x1={M.left} x2={width - M.right} y1={yPrem(0)} y2={yPrem(0)} />
      {data.map((b, i) => b.premium_bps === undefined ? null : <path
        key={b.t}
        className={`pc-bar ${b.premium_bps >= 0 ? "pc-bar-pos" : "pc-bar-neg"}${hover === i ? " pc-bar-on" : ""}`}
        d={barPath(x(i), barW, yPrem(0), yPrem(b.premium_bps))}
      />)}
      {hover !== null ? <line className="pc-cross" x1={x(hover)} x2={x(hover)} y1={M.top} y2={PREMIUM_H - M.bottom} /> : null}
      <rect className="pc-hit" x={M.left} y={M.top} width={innerW} height={premInnerH} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
    </svg></> : null}

    {/* ---------------- one tooltip, every series */}
    {active && hover !== null ? <div className="pc-tip" style={{ left: Math.min(Math.max(x(hover), 120), width - 120) }}>
      <div className="pc-tip-time">{fmtTime(active.t)}</div>
      {active.tokenized !== undefined ? <div><i className="pc-key pc-key-1" /><strong>{fmtUsd(active.tokenized)}</strong> token</div> : null}
      {active.reference !== undefined ? <div><i className="pc-key pc-key-2" /><strong>{fmtUsd(active.reference)}</strong> reference</div> : null}
      {active.premium_bps !== undefined ? <div><i className={`pc-key ${active.premium_bps >= 0 ? "pc-key-pos" : "pc-key-neg"}`} /><strong>{fmtBps(active.premium_bps)}</strong> premium</div> : null}
    </div> : null}

    {/* ---------------- every value, reachable without the chart */}
    <details className="pc-table">
      <summary>Show the data as a table</summary>
      <table>
        <thead><tr><th>Time</th><th className="num">Token</th><th className="num">Reference</th><th className="num">Premium</th></tr></thead>
        <tbody>{data.map((b) => <tr key={b.t}>
          <td>{fmtTime(b.t)}</td>
          <td className="num">{b.tokenized !== undefined ? fmtUsd(b.tokenized) : "—"}</td>
          <td className="num">{b.reference !== undefined ? fmtUsd(b.reference) : "—"}</td>
          <td className="num">{b.premium_bps !== undefined ? fmtBps(b.premium_bps) : "—"}</td>
        </tr>)}</tbody>
      </table>
    </details>
  </div>;
}
