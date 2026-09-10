import { ArrowLeft, ExternalLink, LockKeyhole, Settings2, Shield, WalletCards } from "lucide-react";
import { ActivityTable } from "../components/ActivityTable";
import { explorerHref } from "../components/ExplorerShell";
import { AgentCard } from "../components/AgentCard";
import { useStore } from "../state";
import { addrUrl } from "../lib/config";
import { agentName, CATEGORY_KEYS, CATEGORY_NAMES, native, shortAddr } from "../lib/format";
import { providerName } from "../lib/wallet";

export function AgentDetail({ id, manage = false }: { id: string; manage?: boolean }) {
  const { cfg, ready, agents, receipts, account, connect, notify } = useStore();
  const agent = agents.find(a => String(a.id) === id);
  if (!ready) return <div className="not-found"><strong>Reading agent #{id}…</strong><p>Fetching its owner, operator, treasury and policies from {cfg?.label ?? "the selected network"}.</p></div>;
  if (!agent) return <div className="not-found"><strong>Agent #{id} is unavailable.</strong><p>It may not exist on {cfg?.label ?? "this network"}, or the chain is still loading.</p><a href={explorerHref("/agents",cfg?.network)}>Back to agents</a></div>;
  const name=agentName(agent.id,agent.metadataURI); const rows=receipts.filter(r=>r.agentId===agent.id);
  const epochEnds=(agent.registeredAt+(Number(agent.epoch)+1)*agent.epochLength)*1000;
  const isOwner=account?.toLowerCase()===agent.owner.toLowerCase();
  return <>
    <a className="back-link" href={explorerHref("/agents",cfg?.network)}><ArrowLeft size={15}/>All agents</a>
    <section className="agent-hero">
      <div className="agent-avatar large">{name.slice(0,1).toUpperCase()}</div><div className="agent-title"><span className="eyebrow">AGENT #{id} · {cfg?.label}</span><h1>{name}</h1><div className="identity-line"><span className={agent.suspended?"state-badge suspended":"state-badge live"}>{agent.suspended?"Suspended":"Active"}</span>{agent.guardian!=="0x0000000000000000000000000000000000000000"&&<span className="state-badge guarded"><Shield size={12}/>Guardian armed</span>}</div></div>
      <div className="agent-primary-action">{manage?<a className="btn btn-ghost" href={explorerHref(`/agents/${id}`,cfg?.network)}>Public record</a>:<a className="btn btn-ghost" href={explorerHref(`/agents/${id}/manage`,cfg?.network)}><Settings2 size={15}/>Manage agent</a>}</div>
    </section>
    {!manage ? <>
      <section className="detail-grid">
        <article className="identity-card"><span className="eyebrow">AUTHORITY</span><dl><div><dt>Owner</dt><dd>{cfg&&addrUrl(cfg,agent.owner)?<a href={addrUrl(cfg,agent.owner)!} target="_blank" rel="noreferrer">{agent.owner}<ExternalLink size={12}/></a>:agent.owner}</dd></div><div><dt>Operator</dt><dd>{agent.operator}</dd></div><div><dt>Guardian</dt><dd>{agent.guardian==="0x0000000000000000000000000000000000000000"?"Not appointed":agent.guardian}</dd></div><div><dt>Epoch</dt><dd>#{agent.epoch.toString()} · resets {new Date(epochEnds).toLocaleString()}</dd></div></dl></article>
        <article className="treasury-card"><span className="eyebrow">TREASURY</span><div className="big-balance">{native(agent.balance,cfg?.symbol)}</div><p>The operator can spend this balance only through the category limits below.</p><WalletCards size={46}/></article>
      </section>
      <section className="policy-section"><div className="section-heading"><div><span className="eyebrow">OWNER-SET POLICY</span><h2>Purpose-scoped allowances</h2></div><span className="row-count">Epoch {agent.epoch.toString()}</span></div><div className="policy-grid">{agent.categories.map((c,i)=>{const p=c.cap?Number(c.spent*100n/c.cap):0;return <article key={CATEGORY_KEYS[i]}><div className="policy-top"><span className={`purpose purpose-${CATEGORY_KEYS[i]}`}>{CATEGORY_NAMES[i]}</span><strong>{Math.min(p,100)}%</strong></div><div className="policy-meter"><span className={CATEGORY_KEYS[i]} style={{width:`${Math.min(p,100)}%`}}/></div><dl><div><dt>Spent</dt><dd>{native(c.spent,cfg?.symbol)}</dd></div><div><dt>Epoch cap</dt><dd>{native(c.cap,cfg?.symbol)}</dd></div><div><dt>Per call</dt><dd>{native(c.perCall,cfg?.symbol)}</dd></div></dl></article>})}</div></section>
      <ActivityTable rows={rows} title={`${name} decisions`}/>
    </> : <section className="manage-area"><div className="manage-notice"><LockKeyhole size={22}/><div><h2>Owner controls</h2><p>Wallet access is isolated here. Browsing Quaestor never asks for one.</p></div>{!account?<button className="btn btn-gold" onClick={()=>connect().catch(e=>notify(e.message))}>Connect {providerName()}</button>:<span className={isOwner?"state-badge live":"state-badge suspended"}>{isOwner?"Owner verified":`Connected ${shortAddr(account)}`}</span>}</div><AgentCard agent={agent}/></section>}
  </>;
}
