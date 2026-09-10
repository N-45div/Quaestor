import { ArrowRight, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { explorerHref } from "../components/ExplorerShell";
import { useStore } from "../state";
import { agentName, native, shortAddr, timeAgo } from "../lib/format";

export function AgentsView() {
  const { cfg, ready, agents, receipts } = useStore();
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const [query, setQuery] = useState(params.get("search") ?? "");
  const rows = useMemo(() => agents.map(a => {
    const activity = receipts.filter(r => r.agentId === a.id);
    return { a, activity, latest: activity[0] };
  }).filter(({a}) => {
    const q = query.trim().toLowerCase();
    return !q || agentName(a.id,a.metadataURI).toLowerCase().includes(q) || String(a.id) === q.replace(/^#/,"") || a.owner.toLowerCase().includes(q) || a.operator.toLowerCase().includes(q);
  }), [agents, receipts, query]);

  return <>
    <section className="page-intro compact"><div><span className="eyebrow">AGENT DIRECTORY</span><h1>Agents</h1><p>Every treasury governed by this deployment, with its current authority and observed activity.</p></div></section>
    <div className="list-toolbar"><label><Search size={16}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Filter by name, ID, owner or operator"/></label><span>{rows.length} of {agents.length} agents</span></div>
    <section className="data-section flush">
      <div className="explorer-table-wrap"><table className="explorer-table agents-table"><thead><tr><th>Agent</th><th>Status</th><th>Owner</th><th>Treasury</th><th>Current epoch use</th><th>Last decision</th><th/></tr></thead><tbody>
        {rows.map(({a,activity,latest}) => {
          const spent = a.categories.reduce((n,c)=>n+c.spent,0n); const caps=a.categories.reduce((n,c)=>n+c.cap,0n); const pct=caps?Number(spent*100n/caps):0;
          return <tr key={String(a.id)}><td><a className="agent-cell" href={explorerHref(`/agents/${a.id}`,cfg?.network)}><span className="agent-avatar">{agentName(a.id,a.metadataURI).slice(0,1).toUpperCase()}</span><span><strong>{agentName(a.id,a.metadataURI)}</strong><small>Agent #{a.id.toString()} · {activity.length} decisions</small></span></a></td><td>{a.suspended?<span className="state-badge suspended">Suspended</span>:<span className="state-badge live">Active</span>}</td><td className="mono-muted" title={a.owner}>{shortAddr(a.owner)}</td><td className="numeric">{native(a.balance,cfg?.symbol)}</td><td><div className="mini-meter"><span style={{width:`${Math.min(pct,100)}%`}}/></div><small>{pct}% of epoch caps</small></td><td>{latest?<><strong>{timeAgo(latest.timestamp)}</strong><small>Block {latest.blockNumber.toString()}</small></>:<span className="dim">No indexed activity</span>}</td><td><a className="row-arrow" href={explorerHref(`/agents/${a.id}`,cfg?.network)} aria-label={`Open ${agentName(a.id,a.metadataURI)}`}><ArrowRight size={16}/></a></td></tr>
        })}
        {!ready&&<tr><td colSpan={7} className="table-empty">Reading agents from {cfg?.label ?? "the selected network"}…</td></tr>}
        {ready&&!rows.length&&<tr><td colSpan={7} className="table-empty">No agents match this search.</td></tr>}
      </tbody></table></div>
    </section>
  </>;
}
