import { useEffect, useState } from "react";
import { Activity, ArrowRight, CircleDollarSign, Database, RefreshCw, Route, ShieldAlert } from "lucide-react";
import { useStore } from "../state";

const CATALOG = [
  { method:"GET", path:"/v1/threat/feed/head", job:"Threat feed head", price:"Free", kind:"Read" },
  { method:"GET", path:"/v1/risk/quote?venue=", job:"Preview a venue permit", price:"Free", kind:"Quote" },
  { method:"GET", path:"/v1/threat/lookup?venue=", job:"Read reports for one venue", price:"0.0005 HBAR", kind:"x402" },
  { method:"GET", path:"/v1/risk/check?venue=", job:"Buy a route permit", price:"Risk-priced", kind:"x402" },
  { method:"GET", path:"/v1/venue/quote?venues=", job:"Quote execution venues", price:"0.001 HBAR / venue", kind:"x402" },
  { method:"GET", path:"/v1/policy/evaluate", job:"Evaluate a proposed spend", price:"0.0002 HBAR / rule", kind:"x402" },
] as const;

export function RoutesView(){
  const {cfg}=useStore(); const base=cfg?.decisionLedgerUrl;
  const [venue,setVenue]=useState("quaestor-dex"); const [quote,setQuote]=useState<any>(null); const [feed,setFeed]=useState<any>(null); const [busy,setBusy]=useState(false); const [failure,setFailure]=useState<string|null>(null);
  const load=async()=>{if(!base)return;setBusy(true);setFailure(null);try{const [q,f]=await Promise.all([fetch(`${base}/v1/risk/quote?venue=${encodeURIComponent(venue)}`,{signal:AbortSignal.timeout(10000)}),fetch(`${base}/v1/threat/feed/head`,{signal:AbortSignal.timeout(10000)})]);if(!q.ok||!f.ok)throw new Error(`Hub returned ${q.status}/${f.status}`);setQuote(await q.json());setFeed(await f.json())}catch(e){setFailure((e as Error).message)}finally{setBusy(false)}};
  useEffect(()=>{void load()},[base]);
  return <><section className="page-intro routes-intro"><div><span className="eyebrow">OPENROUTER FOR TRADING AGENTS</span><h1>Routes & x402</h1><p>One machine-readable surface for risk, policy and execution decisions. Prices shown below come from the live hub.</p></div><div className="settlement-mark"><CircleDollarSign/><div><strong>HBAR settlement</strong><span>x402 exact · Hedera testnet</span></div></div></section>
  <section className="route-lab"><div className="route-lab-copy"><span className="eyebrow">LIVE PERMIT QUOTE</span><h2>The price is the risk signal.</h2><p>Each distinct reporting tenant raises the cost for everyone during the 24-hour window. Zero means no reports observed.</p><form onSubmit={e=>{e.preventDefault();void load()}}><input value={venue} onChange={e=>setVenue(e.target.value)} aria-label="Venue identifier" placeholder="Contract, account or host"/><button disabled={busy}>{busy?<RefreshCw className="spin"/>:<ArrowRight/>}<span>{busy?"Quoting":"Quote venue"}</span></button></form>{failure&&<div className="inline-error">Live hub unavailable: {failure}</div>}</div>
    <div className="quote-result"><span className="quote-label">PERMIT NOW</span><div className="quote-price">{quote?.permit?.hbar??"—"}<small>HBAR</small></div><div className="formula"><span>{quote?.permit?.base_hbar??"—"} base</span><b>×</b><span>{quote?.permit?.multiplier??"—"} multiplier</span></div><dl><div><dt>Distinct reporters</dt><dd>{quote?.permit?.reporters??"—"}</dd></div><div><dt>Risk coefficient</dt><dd>k = {quote?.permit?.k??feed?.k??"—"}</dd></div><div><dt>Observed venues</dt><dd>{feed?.venues??"—"}</dd></div><div><dt>Feed records</dt><dd>{feed?.count??"—"}</dd></div></dl></div>
  </section>
  <section className="route-principles"><article><Route/><div><strong>Route discovery</strong><span>Agents see the available decisions and exact prices before paying.</span></div></article><article><ShieldAlert/><div><strong>Policy evaluation</strong><span>Seven rules use chain state and indexed spend shape; stale history refuses.</span></div></article><article><Database/><div><strong>Verifiable output</strong><span>Payments settle independently and governor receipts bind reasons to spends.</span></div></article></section>
  <section className="data-section"><div className="section-heading"><div><span className="eyebrow">PUBLIC SERVICE CATALOG</span><h2>Agent-facing endpoints</h2></div><span className="row-count">6 live routes</span></div><div className="explorer-table-wrap"><table className="explorer-table route-table"><thead><tr><th>Method</th><th>Resource</th><th>Decision</th><th>Price</th><th>Protocol</th></tr></thead><tbody>{CATALOG.map(r=><tr key={r.path}><td><span className="method">{r.method}</span></td><td className="endpoint">{r.path}</td><td>{r.job}</td><td className="numeric">{r.price}</td><td><span className={r.kind==="x402"?"state-badge guarded":"state-badge neutral"}>{r.kind}</span></td></tr>)}</tbody></table></div></section>
  <div className="route-boundary"><Activity/><p><strong>Current enforcement boundary:</strong> the governor enforces owner-set caps. The venue permit is sold and observable, while mandatory permit verification inside the execution path is the next contract version.</p></div></>;
}
