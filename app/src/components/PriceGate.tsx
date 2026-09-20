import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, OctagonX, ShieldQuestion } from "lucide-react";
import {
  checkQuote,
  fetchMarket,
  type InstrumentView,
  type MarketAssessmentView,
} from "../lib/stocks";

const AMOUNTS = [1, 2, 5] as const;
/** The floor sits this far under the expected fill, as the hub's own quotes do. */
const SLIPPAGE_BPS = 50;
/** The meter runs to here; anything past it is simply "far outside". */
const METER_MAX_BPS = 1_500;

const age = (seconds: number): string =>
  seconds < 90 ? `${seconds}s ago` : seconds < 5_400 ? `${Math.round(seconds / 60)}m ago` : `${Math.round(seconds / 3_600)}h ago`;

const REFUSAL_COPY: Record<string, string> = {
  MARKET_DATA_UNAVAILABLE: "No source has published a price it requires, so there is nothing to check a quote against.",
  MARKET_DATA_STALE: "Prices exist, but none recent enough to be a price.",
  MARKET_SOURCES_DISAGREE: "Two independent sources price the same side differently, so neither is believed.",
  SESSION_CLOSED: "The owner does not permit trading in this US market session.",
  PRICE_DISLOCATION: "The token has come loose from its underlying.",
  QUOTE_OFF_MARKET: "The floor this quote guarantees is not a price the observed market supports.",
};

function Verdict({ assessment }: { assessment: MarketAssessmentView | null }) {
  if (!assessment) return <span className="pg-verdict pg-verdict-wait"><ShieldQuestion size={15} />Reading evidence</span>;
  return assessment.allowed
    ? <span className="pg-verdict pg-verdict-ok"><CheckCircle2 size={15} />Allowed</span>
    : <span className="pg-verdict pg-verdict-no"><OctagonX size={15} />Refused · {assessment.refusal?.code}</span>;
}

/**
 * One measure against one limit: how far the quote's floor sits from the market,
 * on a scale where the owner's tolerance is a marked line. The fill carries the
 * magnitude; the verdict beside it carries the meaning, in words and an icon,
 * so the colour is never the only thing saying "refused".
 */
function DeviationMeter({ bps, limit }: { bps: number; limit: number }) {
  const shown = Math.min(Math.abs(bps), METER_MAX_BPS);
  const over = Math.abs(bps) > limit;
  const ticks = [0, 300, 600, 900, 1_200, 1_500];
  return <div className="pg-meter" role="meter" aria-valuemin={0} aria-valuemax={METER_MAX_BPS} aria-valuenow={shown}
    aria-label={`Quote floor is ${Math.abs(bps)} basis points from the observed market; the limit is ${limit}`}>
    <div className="pg-meter-track">
      <div className={over ? "pg-meter-fill pg-meter-fill-over" : "pg-meter-fill"} style={{ width: `${(shown / METER_MAX_BPS) * 100}%` }} />
      <div className="pg-meter-limit" style={{ left: `${(limit / METER_MAX_BPS) * 100}%` }}><span>limit {limit} bps</span></div>
    </div>
    <div className="pg-meter-axis" aria-hidden="true">
      {ticks.map((tick) => <span key={tick} style={{ left: `${(tick / METER_MAX_BPS) * 100}%` }}>{tick === METER_MAX_BPS ? `${tick}+` : tick}</span>)}
    </div>
  </div>;
}

/**
 * The price gate, shown twice: what it sees right now, and what it would say
 * about a quote. The second half is the point. The chain enforces the floor a
 * quote guarantees, and the floor comes from the quote — so the slider plays a
 * venue that promises fewer tokens for the same money, and the gate answers
 * live, from the hub, against prices it observed somewhere else.
 */
export function PriceGate({ base, instrument }: { base: string; instrument: InstrumentView }) {
  const [market, setMarket] = useState<MarketAssessmentView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [amount, setAmount] = useState<(typeof AMOUNTS)[number]>(5);
  // `#/app/stocks?shortfall=6` opens on a venue that delivers 6% too little,
  // so a refusal can be linked to rather than only reached by dragging.
  const [shortfall, setShortfall] = useState(() => {
    const asked = Number(new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("shortfall"));
    return Number.isFinite(asked) && asked > 0 ? Math.min(15, Math.round(asked * 2) / 2) : 0;
  });
  const [checked, setChecked] = useState<MarketAssessmentView | null>(null);
  const [checkFailure, setCheckFailure] = useState<string | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    let live = true;
    const load = () => fetchMarket(base, instrument.mint)
      .then((m) => { if (live) { setMarket(m); setFailure(null); } })
      .catch((e) => { if (live) setFailure((e as Error).message); });
    setMarket(null);
    void load();
    const timer = setInterval(load, 20_000);
    return () => { live = false; clearInterval(timer); };
  }, [base, instrument.mint]);

  const benchmark = market?.consensus.tokenized?.price ?? market?.consensus.reference?.price;

  // The quote the slider describes: a fair fill at the observed price, less the
  // venue's shortfall, with the usual slippage between the estimate and the floor.
  const described = useMemo(() => {
    if (!benchmark) return null;
    const fair = (amount / benchmark) * 10 ** instrument.decimals;
    const tokensOut = Math.max(1, Math.floor(fair * (1 - shortfall / 100)));
    const floor = Math.max(1, Math.floor((tokensOut * (10_000 - SLIPPAGE_BPS)) / 10_000));
    return { usdc_in: String(amount * 1_000_000), tokens_out: String(tokensOut), min_tokens_out: String(floor) };
  }, [amount, shortfall, benchmark, instrument.decimals]);

  useEffect(() => {
    if (!described) return;
    const mine = ++sequence.current;
    // Debounced: a dragged slider should cost the hub one question, not forty.
    const timer = setTimeout(() => {
      checkQuote(base, { instrument_mint: instrument.mint, ...described })
        .then((a) => { if (mine === sequence.current) { setChecked(a); setCheckFailure(null); } })
        .catch((e) => { if (mine === sequence.current) setCheckFailure((e as Error).message); });
    }, 280);
    return () => clearTimeout(timer);
  }, [base, instrument.mint, described]);

  const sides = (["tokenized", "reference"] as const).filter((side) => market?.observations.some((o) => o.side === side));
  const limit = market?.policy.max_quote_deviation_bps ?? 300;
  const quote = checked?.quote;

  return <section className="st-price pg">
    <div className="st-price-head">
      <div>
        <h2>The price gate</h2>
        <p>{market
          ? `${market.session} session · checked against prices observed independently of the venue · ${market.policy_scope && market.policy_scope !== "default" ? `judged under the owner's ${market.policy_scope} policy · ` : ""}fails closed`
          : "Reading the gate's evidence"}</p>
      </div>
      <Verdict assessment={market} />
    </div>

    {failure ? <p className="st-price-note">The gate's evidence is unavailable: {failure}</p> : null}

    {market ? <>
      <p className="st-narrative">
        The program enforces the floor a quote guarantees, and the floor comes from the quote. A venue that
        promises too few tokens passes every on-chain check while robbing the agent, because the chain has
        never seen a price. So before an intent is signed, that floor is measured against prices from
        somewhere else.{" "}
        {market.allowed ? "Right now the evidence is good enough to trade on." : REFUSAL_COPY[market.refusal?.code ?? ""] ?? market.refusal?.message}
      </p>

      <div className="st-tiles">
        <div>
          <span>Observed price</span>
          <strong>{benchmark ? `$${benchmark.toFixed(2)}` : "—"}</strong>
          <small>{market.consensus.tokenized ? "the token's own market" : `${instrument.underlyingSymbol ?? "underlying"} reference — a devnet test mint has no market of its own`}</small>
        </div>
        <div>
          <span>Sources disagree by</span>
          <strong>{Math.max(market.consensus.tokenized?.spread_bps ?? 0, market.consensus.reference?.spread_bps ?? 0)} bps</strong>
          <small>refused past {market.policy.max_source_disagreement_bps} bps: two sources that disagree are not a better price</small>
        </div>
        <div>
          <span>Token vs underlying</span>
          <strong>{market.premium_bps === undefined ? "—" : `${market.premium_bps > 0 ? "+" : ""}${market.premium_bps} bps`}</strong>
          <small>{market.premium_bps === undefined
            ? "needs a price on both sides"
            : `refused past ${market.session === "regular" ? market.policy.max_absolute_premium_bps : market.policy.max_absolute_premium_bps_after_hours} bps in this session`}</small>
        </div>
      </div>

      <table className="st-table pg-sources">
        <thead><tr><th>Side</th><th>Source</th><th className="num">Price</th><th className="num">Seen</th><th>Counts</th></tr></thead>
        <tbody>
          {sides.flatMap((side) => market.observations.filter((o) => o.side === side).map((o) => {
            const fresh = o.age_seconds <= market.policy.max_price_age_seconds;
            return <tr key={`${o.side}:${o.source}`}>
              <td>{o.side === "tokenized" ? "Token" : "Underlying"}</td>
              <td><code className="st-mint">{o.source}</code></td>
              <td className="num">${o.price.toFixed(2)}</td>
              <td className="num">{age(o.age_seconds)}</td>
              <td>{fresh
                ? <span className="st-chip st-chip-live">fresh</span>
                : <span className="st-chip st-chip-muted" title={`Older than ${market.policy.max_price_age_seconds}s: a record of a price, not a price`}>too old to count</span>}</td>
            </tr>;
          }))}
        </tbody>
      </table>

      <div className="pg-stress">
        <div className="pg-stress-head">
          <div>
            <h3>Stress a quote</h3>
            <p>Play a venue that hands over fewer tokens for the same money. The hub answers live.</p>
          </div>
          <Verdict assessment={checked} />
        </div>

        <div className="pg-controls">
          <div className="st-windows" role="group" aria-label="Trade size">
            {AMOUNTS.map((a) => <button key={a} type="button" aria-pressed={a === amount} onClick={() => setAmount(a)}>{a} USDC</button>)}
          </div>
          <label className="pg-slider">
            <span>Venue delivers <strong>{shortfall === 0 ? "a fair amount" : `${shortfall}% fewer tokens`}</strong></span>
            <input type="range" min={0} max={15} step={0.5} value={shortfall} onChange={(e) => setShortfall(Number(e.target.value))}
              aria-label="How many fewer tokens the venue delivers, in percent" />
          </label>
        </div>

        {checkFailure ? <p className="st-price-note">{checkFailure}</p> : null}
        {quote ? <>
          <DeviationMeter bps={quote.deviation_bps} limit={limit} />
          <p className="pg-reading">
            The floor implies <strong>${quote.floor_price_usd.toFixed(2)}</strong> a share against an observed{" "}
            <strong>${quote.benchmark_price_usd.toFixed(2)}</strong>: <strong>{Math.abs(quote.deviation_bps)} bps {quote.deviation_bps >= 0 ? "worse" : "better"}</strong> than the market.{" "}
            {checked?.allowed
              ? "Inside the owner's tolerance, so an intent for it would be signed."
              : checked?.refusal?.code === "QUOTE_OFF_MARKET"
                ? "Every on-chain check would still pass at this price. The gate refuses it anyway — that is what it is for."
                : REFUSAL_COPY[checked?.refusal?.code ?? ""] ?? ""}
          </p>
        </> : null}
      </div>
    </> : null}
  </section>;
}
