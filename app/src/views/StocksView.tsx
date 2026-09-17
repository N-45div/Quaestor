import { useEffect, useState } from "react";
import { AlertTriangle, Building2, CandlestickChart, HelpCircle, Landmark, RefreshCw, ShieldCheck } from "lucide-react";
import {
  fetchCatalog,
  fetchDiscovery,
  fetchVenues,
  premiumPercent,
  ROUTING_COPY,
  routingState,
  shortMint,
  stocksBase,
  type CatalogView,
  type DiscoveryView,
  type InstrumentView,
  type VenueView,
} from "../lib/stocks";

/** A pre-IPO name at a 20% discount to its own provider's mark is the case the
 *  Pyth divergence gate exists for, so the table leads with it. */
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

export function StocksView() {
  const base = stocksBase();
  const [catalog, setCatalog] = useState<CatalogView | null>(null);
  const [venues, setVenues] = useState<VenueView[]>([]);
  const [discovery, setDiscovery] = useState<DiscoveryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

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
      Stocks hub unavailable: {failure}. Start it with <code>npm run services</code> and{" "}
      <code>SOLANA_STOCKS_ENABLED=1</code>.
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
            return <tr key={instrument.mint}>
              <td>
                <div className="st-stack">
                  <strong>{instrument.symbol}</strong>
                  <small>{instrument.name ?? instrument.issuer}</small>
                </div>
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
