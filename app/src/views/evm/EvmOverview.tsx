import { useState } from "react";
import { ArrowRight, ArrowUpRight, Clock3, Database, ShieldCheck, ShieldX, Waypoints, Zap } from "lucide-react";
import { explorerHref } from "../../components/ExplorerShell";
import { fetchGovernors, fetchTrades, sendRefusal, short, show, words, type GovernorRow, type RefusalResult } from "../../lib/evm/stocks";
import { AddressLink, TradesTable, useEvm, useHub } from "./common";

const attacks = (w: ReturnType<typeof words>, budget: string) => [
  { kind: "overpay", label: "Be a hijacked agent", what: `A 1 ${budget} buy with a floor of one wei, through the owner's approved ${w.route}, into ${w.attackerVenue}. The caps, the venue and the floor all pass; ${w.venue}'s trade goes through.` },
  { kind: "short", label: `Demand twice what ${w.venue} pays`, what: `A 1 ${budget} buy with a floor of twice what ${w.venue} gives, and the venue told to accept anything: only the governor's own measurement holds the floor.` },
  { kind: "over-cap", label: "Spend over the cap", what: `A buy of one ${budget} more than the governor's per-trade cap.` },
];

export const agentName = (g: Pick<GovernorRow, "operator" | "demo">) => (g.demo ? "House agent" : `Agent ${short(g.operator)}`);

function Refusals() {
  const { net } = useEvm();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<RefusalResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kinds = new Set(net.demo?.kinds ?? []);

  const attempt = async (kind: string) => {
    setBusy(kind);
    setError(null);
    setResult(null);
    try {
      setResult(await sendRefusal(net.key, kind));
    } catch (e) {
      setError((e as Error).name === "TimeoutError" ? "The hub did not answer in two minutes; a free instance may be waking. Try once more." : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!net.demo) return null;
  const moved = result && (result.budgetBefore !== result.budgetAfter || result.sharesBefore !== result.sharesAfter);
  return (
    <section className="data-section refusals-section">
      <div className="section-heading"><div><span className="eyebrow">REFUSED ON CHAIN</span><h2>Try to break it</h2></div><span className="row-count">{net.name} transactions</span></div>
      <div className="demo-box">
        <div className="demo-copy">
          <h3><Zap size={16} />Send the house agent a trade it must refuse</h3>
          <p>It goes straight to the governor on {net.name}, past every check the agent&rsquo;s own command makes first, signed by the hub&rsquo;s operator key. It lands as a failed transaction anyone can open, costs a fraction of a cent in gas, and moves nothing.</p>
        </div>
        <div className="demo-actions">
          {attacks(words(net), net.budget.symbol).filter((a) => kinds.has(a.kind)).map((a) => (
            <button key={a.kind} type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void attempt(a.kind)} title={a.what}>
              {busy === a.kind ? `Sending to ${net.name}…` : a.label}
            </button>
          ))}
        </div>
        {error && <p className="form-msg err">{error}</p>}
        {result && (
          <div className="demo-outcome refused">
            <div className="refusal-top"><ShieldX size={16} /><code>{result.refused}</code></div>
            <p>{result.what}</p>
            {result.plain ? <p>{result.plain}</p> : null}
            <p>{result.meaning} <small className="muted-copy">{result.detail}</small></p>
            <p className="demo-balances">Budget {show(result.budgetBefore)} → {show(result.budgetAfter)} {net.budget.symbol} · shares {show(result.sharesBefore, 8)} → {show(result.sharesAfter, 8)} {net.demo.stock} · {moved ? "a balance changed while this ran (another trade?)" : "nothing moved"}</p>
            <a className="mono-link" href={result.explorer} target="_blank" rel="noreferrer">Your transaction {short(result.tx)}<ArrowUpRight size={12} /></a>
          </div>
        )}
      </div>
    </section>
  );
}

export function EvmOverview() {
  const { net } = useEvm();
  const governors = useHub(() => fetchGovernors(net.key), [net.key]);
  const trades = useHub(() => fetchTrades(net.key), [net.key]);
  const rows = trades.data?.trades ?? [];
  const gs = governors.data ?? [];
  const spent = rows.reduce((sum, t) => sum + Number(t.spent), 0);
  const labelOf = (address: string) => {
    const g = gs.find((x) => x.address.toLowerCase() === address.toLowerCase());
    return g ? agentName(g) : `Governor ${short(address)}`;
  };
  const stocks = net.instruments.map((i) => i.symbol).join(", ");
  const w = words(net);

  return <>
    <section className="page-intro overview-intro">
      <div>
        <span className="eyebrow">LIVE ON {net.name.toUpperCase()}</span>
        <h1>{w.Asset === "Stock" ? "Stock agents" : "Trading agents"} under a contract&rsquo;s limits.</h1>
        <p>An AI agent buys {stocks} with {net.budget.symbol} on {w.venue}, and a governor contract of its owner&rsquo;s measures every fill: the caps, the owner&rsquo;s limit price and Chainlink&rsquo;s price for the {w.unit}. Everything below is read from {net.name} by the hub on request.</p>
      </div>
      <div className="network-pulse"><span className={governors.error ? "pulse-warn" : "pulse-live"} /><div><strong>{governors.error ? "The chain is not answering" : `${net.name} responding`}</strong><small>Factory <AddressLink value={net.factory} /></small></div></div>
    </section>

    <section className="metric-grid">
      <article><span className="metric-icon"><ShieldCheck /></span><div className="metric-label">Governed agents</div><div className="metric-value">{governors.data ? gs.length : "—"}</div><div className="metric-foot">{gs.filter((g) => !g.suspended).length} active</div></article>
      <article><span className="metric-icon"><Database /></span><div className="metric-label">Budget asset</div><div className="metric-value metric-money">{net.budget.symbol}</div><div className="metric-foot">{net.testnet ? "Test tokens" : "Paxos, on chain"}</div></article>
      <article><span className="metric-icon"><Waypoints /></span><div className="metric-label">Settled trades</div><div className="metric-value">{trades.data ? rows.length : "—"}</div><div className="metric-foot">{show(String(spent))} {net.budget.symbol} spent</div></article>
      <article><span className="metric-icon"><Clock3 /></span><div className="metric-label">{w.Assets}</div><div className="metric-value">{net.instruments.length}</div><div className="metric-foot">{stocks}</div></article>
    </section>

    <section className="overview-split">
      <div className="routing-panel">
        <span className="eyebrow">BRING YOUR AGENT</span><h2>Your agent, your governor, your limits</h2>
        <p className="muted-copy">Any wallet can open a governor of its own: its own {net.budget.symbol}, its own caps and limit prices, its own agent key. One signature sets all of it and sends the agent its gas. The agent can buy inside the limits and nothing else; what it buys stays in the governor until you take it out.</p>
        <a className="text-cta" href={explorerHref(`/evm/${net.key}/register`)}>Open a governor <ArrowRight size={15} /></a>
      </div>
      <div className="leader-panel">
        <span className="eyebrow">WHAT THE CONTRACT CHECKS</span>
        <ul className="plain-list">
          <li>The per-trade and per-epoch caps, and that the intent never ran before.</li>
          <li>The venue and the {w.unit} are on the owner&rsquo;s lists.</li>
          <li>What left the budget and what arrived, measured, never read from the route.</li>
          <li>The price paid per {w.unit} against the owner&rsquo;s limit and Chainlink&rsquo;s price.</li>
        </ul>
      </div>
    </section>

    {w.testnetNote && <p className="testnet-note"><strong>On a testnet.</strong> {w.testnetNote}</p>}

    {(governors.error || trades.error) && <div className="data-warning"><span>{governors.error ?? trades.error}. The page keeps trying every 20 seconds.</span></div>}
    <Refusals />

    <section className="data-section">
      <div className="section-heading"><div><span className="eyebrow">GOVERNORS</span><h2>Every governor the factory made</h2></div><span className="row-count">{gs.length} on chain</span></div>
      <div className="explorer-table-wrap">
        <table className="explorer-table">
          <thead><tr><th>Agent</th><th>Governor</th><th>Owner</th><th>Agent key</th><th>State</th></tr></thead>
          <tbody>
            {gs.map((g) => (
              <tr key={g.address}>
                <td><a className="table-primary" href={explorerHref(`/evm/${net.key}/agents/${g.address}`)}>{agentName(g)}</a></td>
                <td><AddressLink value={g.address} /></td>
                <td><AddressLink value={g.owner} /></td>
                <td><AddressLink value={g.operator} /></td>
                <td>{g.suspended ? <span className="status-inline warn"><i />Suspended</span> : <span className="status-inline"><i />Active</span>}</td>
              </tr>
            ))}
            {!gs.length && <tr><td className="table-empty" colSpan={5}>{governors.data ? "No governor yet." : "Reading the factory…"}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>

    <TradesTable rows={rows} limit={12} labelOf={labelOf} source={trades.data?.source} />
  </>;
}
