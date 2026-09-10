import { FormEvent, type ReactNode, useState } from "react";
import { Activity, Bot, Boxes, ChevronDown, CircleDollarSign, Code2, Network, Route, Search } from "lucide-react";
import { CHAINS, type ChainKey } from "../lib/config";
import { useStore } from "../state";

export const explorerHref = (path: string, chain?: string) =>
  `#/app${path}${chain ? `?chain=${encodeURIComponent(chain)}` : ""}`;

export function ExplorerShell({ route, children }: { route: string; children: ReactNode }) {
  const { cfg, agents, receipts } = useStore();
  const [query, setQuery] = useState("");
  const path = route.slice(5).split("?")[0] || "/";
  const active = (prefix: string) => prefix === "/" ? path === "/" : path.startsWith(prefix);

  const search = (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    const numeric = q.replace(/^#/, "");
    if (/^\d+$/.test(numeric) && agents.some(a => a.id === BigInt(numeric))) {
      window.location.hash = explorerHref(`/agents/${numeric}`, cfg?.network);
      return;
    }
    const needle = q.toLowerCase();
    const receipt = receipts.find(r => r.txHash.toLowerCase() === needle || r.metaHash.toLowerCase() === needle);
    if (receipt) {
      window.location.hash = explorerHref(`/decisions/${receipt.metaHash}`, cfg?.network);
      return;
    }
    const agent = agents.find(a => [a.owner, a.operator, a.guardian].some(x => x.toLowerCase() === needle));
    if (agent) window.location.hash = explorerHref(`/agents/${agent.id}`, cfg?.network);
    else window.location.hash = explorerHref(`/agents?search=${encodeURIComponent(q)}`, cfg?.network);
  };

  const setChain = (key: ChainKey) => {
    window.location.hash = explorerHref(path, key);
  };

  return (
    <div className="explorer">
      <header className="explorer-header">
        <div className="explorer-brand-row">
          <a className="explorer-wordmark" href="#/">QU<span>Æ</span>STOR</a>
          <div className="explorer-rule" />
          <span className="explorer-product">Agent Explorer</span>
          <a className="icon-link" href="https://github.com/N-45div/Quaestor" target="_blank" rel="noreferrer" aria-label="Quaestor source on GitHub"><Code2 size={17}/></a>
        </div>
        <div className="explorer-tools">
          <form className="global-search" onSubmit={search}>
            <Search size={17}/>
            <input value={query} onChange={e => setQuery(e.target.value)} aria-label="Search the explorer" placeholder="Search agent, owner, transaction or decision hash" />
            <kbd>/</kbd>
          </form>
          <label className="chain-select">
            <span className={`chain-mark chain-${cfg?.network ?? "loading"}`} />
            <select value={(cfg?.network ?? "xlayerTestnet") as ChainKey} onChange={e => setChain(e.target.value as ChainKey)} aria-label="Network">
              {CHAINS.map(c => <option value={c.key} key={c.key}>{c.label}</option>)}
            </select>
            <ChevronDown size={14}/>
          </label>
        </div>
        <nav className="explorer-nav" aria-label="Explorer sections">
          <a className={active("/") ? "active" : ""} href={explorerHref("/", cfg?.network)}><Activity size={16}/>Overview</a>
          <a className={active("/agents") ? "active" : ""} href={explorerHref("/agents", cfg?.network)}><Bot size={16}/>Agents</a>
          <a className={active("/decisions") ? "active" : ""} href={explorerHref("/decisions", cfg?.network)}><Boxes size={16}/>Decisions</a>
          <a className={active("/routes") ? "active" : ""} href={explorerHref("/routes", cfg?.network)}><Route size={16}/>Routes & x402</a>
          <a className={active("/networks") ? "active" : ""} href={explorerHref("/networks", cfg?.network)}><Network size={16}/>Networks</a>
        </nav>
      </header>
      <main className="explorer-main">{children}</main>
      <footer className="explorer-footer">
        <span><CircleDollarSign size={15}/>One governed endpoint for trading agents.</span>
        <span>Public reads require no wallet.</span>
      </footer>
    </div>
  );
}
