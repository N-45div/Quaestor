import { FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Activity, Bot, Boxes, Check, ChevronDown, CircleDollarSign, Code2, Network, Route, Search } from "lucide-react";
import { CHAINS, type ChainKey } from "../lib/config";
import { useStore } from "../state";

export const explorerHref = (path: string, chain?: string) =>
  `#/app${path}${chain ? `?chain=${encodeURIComponent(chain)}` : ""}`;

export function ExplorerShell({ route, children }: { route: string; children: ReactNode }) {
  const { cfg, agents, receipts } = useStore();
  const [query, setQuery] = useState("");
  const [chainOpen, setChainOpen] = useState(false);
  const chainMenuRef = useRef<HTMLDivElement>(null);
  const path = route.slice(5).split("?")[0] || "/";
  const active = (prefix: string) => prefix === "/" ? path === "/" : path.startsWith(prefix);
  const currentChain = CHAINS.find(chain => chain.key === cfg?.network) ?? CHAINS[0];

  useEffect(() => {
    if (!chainOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!chainMenuRef.current?.contains(event.target as Node)) setChainOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChainOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [chainOpen]);

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
    setChainOpen(false);
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
          <div className="chain-picker" ref={chainMenuRef}>
            <button className="chain-button" type="button" aria-label="Select network" aria-haspopup="menu" aria-expanded={chainOpen} onClick={() => setChainOpen(open => !open)}>
              <span className={`chain-mark chain-${currentChain.key}`} />
              <span>{currentChain.label}</span>
              <ChevronDown className={chainOpen ? "open" : ""} size={14}/>
            </button>
            {chainOpen ? <div className="chain-menu-popover" role="menu" aria-label="Networks">
              <div className="chain-menu-label">Select network</div>
              {CHAINS.map(chain => <button key={chain.key} type="button" role="menuitemradio" aria-checked={chain.key === currentChain.key} className={chain.key === currentChain.key ? "selected" : ""} onClick={() => setChain(chain.key)}>
                <span className={`chain-mark chain-${chain.key}`} />
                <span><strong>{chain.label}</strong><small>Testnet</small></span>
                {chain.key === currentChain.key ? <Check /> : null}
              </button>)}
            </div> : null}
          </div>
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
