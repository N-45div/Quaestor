import { useEffect, useState } from "react";
import { AlertTriangle, Building2, CandlestickChart, HelpCircle, Landmark, RefreshCw, ShieldCheck } from "lucide-react";
import { PriceCharts } from "../components/PriceCharts";
import { PriceGate } from "../components/PriceGate";
import { GovernorPanel } from "../components/GovernorPanel";
import { AgentAccess } from "../components/AgentAccess";
import {
  fetchCatalog,
  fetchDiscovery,
  fetchPrices,
  fetchVenues,
  PRICE_WINDOWS,
  premiumPercent,
  ROUTING_COPY,
  routingState,
  shortMint,
  stocksBase,
  type CatalogView,
  type DiscoveryView,
  type InstrumentView,
  type PriceSummaryView,
  type PriceWindow,
  type VenueView,
} from "../lib/stocks";

/** A pre-IPO name at a 20% discount to its own provider's mark is the case the
 *  price gate exists for, so the table leads with it. */
const premiumClass = (bps: number): string =>
  Math.abs(bps) >= 500 ? "st-prem-wide" : Math.abs(bps) >= 100 ? "st-prem-watch" : "st-prem-tight";

function VenueChips({ instrument }: { instrument: InstrumentView }) {
  const venues = instrument.tradableVenues ?? [];
  const unknown = instrument.routabilityUnknownVenues ?? [];
  if (instrument.tradableVenues === undefined) return <span className="st-chip st-chip-muted">not measured</span>;
  if (venues.length === 0 && unknown.length === 0) return <span className="st-chip st-chip-muted">none</span>;
  return <span className="st-chip-row">
    {venues.map(venue => <span key={venue} className="st-chip st-chip-live">{venue}</span>)}
    {unknown.map(venue => <span key={venue} className="st-chip st-chip-unknown" title="Could not be asked — a timeout or a rate limit">{venue}?</span>)}
  </span>;
}

const TREND_COPY = { widening: "gap widening", narrowing: "gap narrowing", stable: "gap steady" } as const;

/**
 * The live tape for one instrument: what the agent reads, drawn for a person.
 * The narrative at the top is the same sentence the agent gets over MCP, so a
 * judge sees exactly what the model saw.
 */
function LivePrices({ base, instrument }: { base: string; instrument: InstrumentView }) {
  const [window, setWindow] = useState<PriceWindow>("1h");
  const [summary, setSummary] = useState<PriceSummaryView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => fetchPrices(base, instrument.mint, window)
      .then((s) => { if (live) { setSummary(s); setFailure(null); } })
      .catch((e) => { if (live) setFailure((e as Error).message); });
    setSummary(null);
    void load();
    // The hub samples every 20s; asking faster would only re-read the same tape.
    const timer = setInterval(load, 20_000);
    return () => { live = false; clearInterval(timer); };
  }, [base, instrument.mint, window]);

  const p = summary?.premium;
  return <section className="st-price" aria-live="polite">
    <div className="st-price-head">
      <div>
        <h2>{instrument.symbol} live tape</h2>
        <p>{summary ? `${summary.session.us_equity} session · ${summary.session.basis}` : "Reading the tape"}</p>
      </div>
      <div className="st-windows" role="group" aria-label="Time window">
        {PRICE_WINDOWS.map((w) => <button key={w} type="button" aria-pressed={w === window} onClick={() => setWindow(w)}>{w}</button>)}
      </div>
    </div>
    {failure ? <p className="st-price-note">
      {/404/.test(failure)
        ? "The live tape covers the listed xStocks today; pre-IPO names are measured for routability but not yet sampled."
        : `Live prices unavailable: ${failure}`}
    </p> : null}
    {summary ? <>
      <p className="st-narrative">{summary.narrative}</p>
      <div className="st-tiles">
        <div><span>Token</span><strong>{summary.tokenized ? `$${summary.tokenized.last.toFixed(2)}` : "—"}</strong><small>{summary.tokenized ? `${summary.tokenized.change_pct >= 0 ? "+" : ""}${summary.tokenized.change_pct}% · ${summary.tokenized.source}` : "no price in window"}</small></div>
        <div><span>Reference</span><strong>{summary.reference ? `$${summary.reference.last.toFixed(2)}` : "—"}</strong><small>{summary.reference ? `${summary.reference.change_pct >= 0 ? "+" : ""}${summary.reference.change_pct}% · ${summary.reference.source}` : "no reference in window"}</small></div>
        <div><span>Premium now</span><strong>{p ? `${p.now_bps > 0 ? "+" : ""}${p.now_bps} bps` : "—"}</strong><small>{p ? `${TREND_COPY[p.trend]} · range ${p.min_bps} to ${p.max_bps}` : "needs both sides"}</small></div>
      </div>
      <div className="st-price-body"><PriceCharts summary={summary} /></div>
    </> : null}
  </section>;
}

export function StocksView() {
  const base = stocksBase();
  const [catalog, setCatalog] = useState<CatalogView | null>(null);
  const [venues, setVenues] = useState<VenueView[]>([]);
  const [discovery, setDiscovery] = useState<DiscoveryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    setFailure(null);
    try {
      // Discovery and venues answer immediately; the catalogue probes every
      // mint against every venue, so it is fetched alongside rather than after.
      const [head, venueList, rows] = await Promise.all([
        fetchDiscovery(base),
        fetchVenues(base),
        fetchCatalog(base),
      ]);
      setDiscovery(head);
      setVenues(venueList);
      setCatalog(rows);
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const instruments = catalog?.instruments ?? [];
  // Default to the first instrument the owner has approved: it is the one an
  // agent could actually trade, so it is the tape worth opening first.
  const focus = instruments.find((i) => i.mint === selected)
    ?? instruments.find((i) => i.enabled)
    ?? instruments[0];
  const tradeable = instruments.filter(i => routingState(i) === "tradeable");
  const routable = instruments.filter(i => routingState(i) === "routable");
  const unknown = instruments.filter(i => routingState(i) === "unknown");

  return <>
    <section className="page-intro overview-intro">
      <div>
        <span className="eyebrow">TOKENIZED EQUITIES UNDER POLICY</span>
        <h1>Listed is not the same as permitted.</h1>
        <p>
          Every instrument here was pulled from its issuer and verified on-chain, then each mint was
          asked of every venue we can quote. What a venue will fill and what an owner allows are
          different facts, and this table keeps them apart.
        </p>
      </div>
      <div className="network-pulse">
        <span className={discovery && !failure ? "pulse-live" : "pulse-warn"} />
        <div>
          <strong>{discovery ? `Execution ${discovery.execution}` : "Contacting hub"}</strong>
          <small>{discovery ? `${discovery.network} · ${base.replace(/^https?:\/\//, "")}` : base}</small>
        </div>
      </div>
    </section>

    {failure ? <div className="inline-error">
      Stocks hub unavailable: {failure}. A free instance sleeps when idle and takes about a minute to wake;
      try again shortly. Running your own: <code>npm run services:stocks</code> with <code>SOLANA_STOCKS_ENABLED=1</code>.
    </div> : null}

    <section className="metric-grid">
      <article>
        <span className="metric-icon"><Landmark /></span>
        <div className="metric-label">Instruments listed</div>
        <div className="metric-value">{catalog ? instruments.length : "—"}</div>
        <div className="metric-foot">{catalog?.sources.map(s => `${s.provider} ${s.status === "ok" ? s.count : "×"}`).join(" · ") || "Loading catalogue"}</div>
      </article>
      <article>
        <span className="metric-icon"><ShieldCheck /></span>
        <div className="metric-label">Tradeable</div>
        <div className="metric-value">{catalog ? tradeable.length : "—"}</div>
        <div className="metric-foot">Owner has approved the mint</div>
      </article>
      <article>
        <span className="metric-icon"><CandlestickChart /></span>
        <div className="metric-label">Routable, not permitted</div>
        <div className="metric-value">{catalog ? routable.length : "—"}</div>
        <div className="metric-foot">A venue will fill it; no owner approval</div>
      </article>
      <article>
        <span className="metric-icon"><HelpCircle /></span>
        <div className="metric-label">Routing unknown</div>
        <div className="metric-value">{catalog ? unknown.length : "—"}</div>
        <div className="metric-foot">Venue could not be asked, not a refusal</div>
      </article>
    </section>

    {focus ? <LivePrices base={base} instrument={focus} /> : null}

    {/* The gate only has a verdict for what this deployment trades; a name that
        is merely listed has no quote to check. */}
    {focus?.enabled ? <PriceGate base={base} instrument={focus} /> : null}

    {discovery ? <GovernorPanel base={base} discovery={discovery} decimals={Object.fromEntries(instruments.map((i) => [i.mint, i.decimals]))} /> : null}

    <AgentAccess base={base} />

    <section className="st-wrap">
      <div className="st-head">
        <div>
          <h2>Catalogue</h2>
          <p>{venues.length > 0 ? `Probed against ${venues.map(v => v.label).join(", ")}` : "No venue configured to quote"}</p>
        </div>
        <button className="st-ghost" type="button" disabled={busy} onClick={() => void load()}>
          {busy ? <RefreshCw className="spin" size={15} /> : <RefreshCw size={15} />}
          <span>{busy ? "Probing venues" : "Re-probe"}</span>
        </button>
      </div>

      <table className="st-table">
        <thead>
          <tr>
            <th>Instrument</th>
            <th>Class</th>
            <th className="num">Premium to mark</th>
            <th>Routing</th>
            <th>Venues</th>
            <th>Mint</th>
          </tr>
        </thead>
        <tbody>
          {instruments.length === 0 && !busy ? <tr><td colSpan={6} className="st-empty">
            {failure ? "Catalogue unavailable." : "No instruments returned."}
          </td></tr> : null}
          {instruments.map(instrument => {
            const state = routingState(instrument);
            const premium = instrument.referenceData?.premiumBps;
            return <tr key={instrument.mint} className={focus?.mint === instrument.mint ? "st-selected" : undefined}>
              <td>
                <button type="button" className="st-pick" aria-pressed={focus?.mint === instrument.mint} onClick={() => setSelected(instrument.mint)}>
                  <strong>{instrument.symbol}</strong>
                  <small>{instrument.name ?? instrument.issuer}</small>
                </button>
              </td>
              <td>
                <span className={instrument.assetClass === "private-company-exposure" ? "st-chip st-chip-private" : "st-chip st-chip-public"}>
                  {instrument.assetClass === "private-company-exposure" ? <Building2 size={12} /> : <Landmark size={12} />}
                  {instrument.provider ?? "—"}
                </span>
              </td>
              <td className="num">
                {premium === undefined
                  ? <span className="st-muted">—</span>
                  : <span className={premiumClass(premium)}>{premiumPercent(premium)}</span>}
              </td>
              <td>
                <span className={`st-routing st-routing-${state}`} title={ROUTING_COPY[state].detail}>
                  {state === "unknown" ? <AlertTriangle size={12} /> : null}
                  {ROUTING_COPY[state].label}
                </span>
              </td>
              <td><VenueChips instrument={instrument} /></td>
              <td><code className="st-mint">{shortMint(instrument.mint)}</code></td>
            </tr>;
          })}
        </tbody>
      </table>

      <div className="st-note">
        <ShieldCheck size={15} />
        <p>
          <strong>Why nothing private is tradeable here:</strong> a catalogue fetched from a
          provider&rsquo;s API may report that a venue will fill a mint, but it must never be able to
          decide what an agent may buy. Approving a mint is an owner action, recorded on-chain.
          Routability is the evidence for that decision, not the decision.
        </p>
      </div>
    </section>
  </>;
}
