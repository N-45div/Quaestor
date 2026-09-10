import { ArrowRight, CheckCircle2, Clock3, Database, ShieldCheck, Waypoints } from "lucide-react";
import { useMemo } from "react";
import { useStore } from "../state";
import { ActivityTable } from "../components/ActivityTable";
import { explorerHref } from "../components/ExplorerShell";
import { agentName, CATEGORY_KEYS, native, timeAgo } from "../lib/format";

export function ExplorerOverview() {
  const { cfg, ready, error, agents, receipts, receiptStatus } = useStore();
  const active = agents.filter(a => !a.suspended);
  const treasury = agents.reduce((sum, a) => sum + a.balance, 0n);
  const recent = receipts.filter(r => r.timestamp > Date.now() - 86400000);
  const recentSpend = recent.reduce((sum, r) => sum + r.amount, 0n);
  const latest = receipts[0];
  const busiest = useMemo(() => {
    const counts = new Map<string, number>();
    receipts.forEach(r => counts.set(String(r.agentId), (counts.get(String(r.agentId)) ?? 0) + 1));
    return [...counts.entries()].sort((a,b) => b[1]-a[1])[0];
  }, [receipts]);
  const busiestAgent = agents.find(a => String(a.id) === busiest?.[0]);

  return <>
    <section className="page-intro overview-intro">
      <div><span className="eyebrow">LIVE GOVERNED ACTIVITY</span><h1>The public record of agent money.</h1><p>Follow every allowance, decision and settlement through the governor on {cfg?.label ?? "this network"}. Every row resolves to evidence.</p></div>
      <div className="network-pulse"><span className={ready && !error ? "pulse-live" : "pulse-warn"}/><div><strong>{ready && !error ? "Network responding" : "Connecting to network"}</strong><small>{cfg ? `Chain ${cfg.chainId} · ${cfg.contracts.Quaestor.slice(0,10)}…` : "Loading deployment"}</small></div></div>
    </section>

    <section className="metric-grid">
      <article><span className="metric-icon"><ShieldCheck/></span><div className="metric-label">Governed agents</div><div className="metric-value">{ready ? agents.length : "—"}</div><div className="metric-foot">{ready ? <><b>{active.length}</b> able to spend</> : "Reading chain state"}</div></article>
      <article><span className="metric-icon"><Database/></span><div className="metric-label">Treasury under policy</div><div className="metric-value metric-money">{ready ? native(treasury, cfg?.symbol) : "—"}</div><div className="metric-foot">Across this deployment</div></article>
      <article><span className="metric-icon"><Waypoints/></span><div className="metric-label">Decisions · 24 hours</div><div className="metric-value">{recent.length}</div><div className="metric-foot">{native(recentSpend, cfg?.symbol)} settled</div></article>
      <article><span className="metric-icon"><Clock3/></span><div className="metric-label">Latest settlement</div><div className="metric-value metric-time">{latest ? timeAgo(latest.timestamp) : "—"}</div><div className="metric-foot">{latest ? `Block ${latest.blockNumber}` : "No indexed activity"}</div></article>
    </section>

    <section className="overview-split">
      <div className="routing-panel">
        <span className="eyebrow">ROUTING PLANE</span><h2>What agents can ask Quaestor to decide</h2>
        <div className="route-summary"><div><i className="route-line"/><span>Venue risk</span><strong>Live herd price</strong></div><div><i className="route-line orange"/><span>Budget policy</span><strong>7 checks</strong></div><div><i className="route-line green"/><span>Settlement</span><strong>x402 · HBAR</strong></div></div>
        <a className="text-cta" href={explorerHref("/routes", cfg?.network)}>Inspect live routes <ArrowRight size={15}/></a>
      </div>
      <div className="leader-panel">
        <span className="eyebrow">MOST OBSERVED</span>
        {busiestAgent ? <><h2>{agentName(busiestAgent.id, busiestAgent.metadataURI)}</h2><div className="leader-id">Agent #{busiestAgent.id.toString()}</div><div className="leader-count">{busiest?.[1]} <span>indexed decisions</span></div><a className="text-cta" href={explorerHref(`/agents/${busiestAgent.id}`, cfg?.network)}>Open agent record <ArrowRight size={15}/></a></> : <p className="muted-copy">Activity will appear after the first governed settlement.</p>}
      </div>
    </section>

    {receiptStatus.error && <div className="data-warning"><CheckCircle2 size={17}/><span>Chain state is live. Receipt history is temporarily degraded: {receiptStatus.error}</span></div>}
    <ActivityTable rows={receipts.slice(0, 12)}/>
  </>;
}
