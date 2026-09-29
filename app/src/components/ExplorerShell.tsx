import { FormEvent, type ReactNode, useState } from "react";
import { Activity, Bot, Boxes, CandlestickChart, CircleDollarSign, Code2, Route, Search } from "lucide-react";
import { useStore } from "../state";

export const explorerHref = (path: string, chain?: string) =>
  `#/app${path}${chain ? `?chain=${encodeURIComponent(chain)}` : ""}`;

/**
 * The two halves of the product, by chain family rather than by network,
 * because neither half is one network. EVM is the spend governor on Base
 * mainnet with its house agent, Cato, trading on Uniswap. Solana is tokenized
 * stocks: the governor runs on devnet and the Meteora curve on mainnet, and
 * the tab says both rather than rounding either up.
 */
const SIDES = {
  evm: [
    { href: "/", label: "Overview", icon: Activity },
    { href: "/agents", label: "Agents", icon: Bot },
    { href: "/decisions", label: "Decisions", icon: Boxes },
  ],
  stocks: [
    { href: "/evm/robinhood-testnet", label: "Robinhood Chain", icon: CandlestickChart },
    { href: "/evm/monad-testnet", label: "Monad", icon: Activity },
  ],
  solana: [
    { href: "/sol", label: "Overview", icon: Activity },
    { href: "/sol/agents", label: "Agents", icon: Bot },
    { href: "/sol/trades", label: "Trades", icon: Boxes },
    { href: "/stocks", label: "Stocks", icon: CandlestickChart },
    { href: "/routes", label: "Routes & x402", icon: Route },
  ],
} as const;

type Side = keyof typeof SIDES;

/** Which half a page belongs to, from its path alone, so a shared link opens on the right tab. */
export const sideOf = (path: string): Side =>
  path.startsWith("/evm") ? "stocks"
  : SIDES.solana.some(item => path.startsWith(item.href)) ? "solana" : "evm";

export function ExplorerShell({ route, children }: { route: string; children: ReactNode }) {
  const { cfg, agents, receipts } = useStore();
  const [query, setQuery] = useState("");
  const path = route.slice(5).split("?")[0] || "/";
  // An overview is active on its own path only; the rest on anything beneath them.
  const active = (prefix: string) => prefix === "/" || prefix === "/sol" ? path === prefix : path === prefix || path.startsWith(`${prefix}/`);
  // On the agent-governor side, the chain in the path is the one "Open a governor" opens on.
  const evmNet = path.startsWith("/evm/") ? path.split("/")[2] : "robinhood-testnet";
  const side = sideOf(path);

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


  return (
    <div className="explorer">
      <header className="explorer-header">
        <div className="explorer-brand-row">
          <a className="explorer-wordmark" href="#/">QU<span>Æ</span>STOR</a>
          <div className="explorer-rule" />
          <span className="explorer-product">Agent Explorer</span>
          <a className="icon-link" href="https://gitlab.com/ndivij2004/quaestor" target="_blank" rel="noreferrer" aria-label="Quaestor source on GitLab"><Code2 size={17}/></a>
        </div>
        <div className="explorer-tools">
          <form className="global-search" onSubmit={search}>
            <Search size={17}/>
            <input value={query} onChange={e => setQuery(e.target.value)} aria-label="Search the explorer" placeholder="Search agent, owner, transaction or decision hash" />
            <kbd>/</kbd>
          </form>
        </div>
        <div className="explorer-navrow">
          <nav className="explorer-nav" aria-label={`${side === "evm" ? "EVM" : side === "stocks" ? "Robinhood Chain" : "Solana"} sections`}>
            {SIDES[side].map(item => <a key={item.href} className={active(item.href) ? "active" : ""} href={explorerHref(item.href, side === "evm" ? cfg?.network : undefined)}><item.icon size={16}/>{item.label}</a>)}
            {side === "stocks" && <a className={path.endsWith("/register") ? "active" : ""} href={explorerHref(`/evm/${evmNet}/register`)}><Bot size={16}/>Open a governor</a>}
            {side === "stocks" && <a className={path.endsWith("/buy") ? "active" : ""} href={explorerHref(`/evm/${evmNet}/buy`)}><CircleDollarSign size={16}/>Buy</a>}
          </nav>
          <div className="side-switch" role="tablist" aria-label="Chain">
            <a role="tab" aria-selected={side === "evm"} className={side === "evm" ? "selected" : ""} href={explorerHref("/", "base")}>
              <span className="chain-mark chain-base" />
              <span><strong>EVM</strong><small>Base mainnet · governor</small></span>
            </a>
            <a role="tab" aria-selected={side === "stocks"} className={side === "stocks" ? "selected" : ""} href={explorerHref("/evm/robinhood-testnet")}>
              <span className="chain-mark chain-robinhood" />
              <span><strong>Agent governors</strong><small>Robinhood Chain · Monad</small></span>
            </a>
            <a role="tab" aria-selected={side === "solana"} className={side === "solana" ? "selected" : ""} href={explorerHref("/sol")}>
              <span className="chain-mark chain-solana" />
              <span><strong>Solana</strong><small>Devnet governor · mainnet curve</small></span>
            </a>
          </div>
        </div>
      </header>
      <main className="explorer-main">{children}</main>
      <footer className="explorer-footer">
        <span><CircleDollarSign size={15}/>One governed endpoint for trading agents.</span>
        <span>Public reads require no wallet.</span>
      </footer>
    </div>
  );
}
