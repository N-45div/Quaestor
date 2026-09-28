import { Suspense, lazy, useEffect, useState } from "react";
import { StoreProvider } from "./state";
import { Landing } from "./views/Landing";
import { ExplorerShell } from "./components/ExplorerShell";
import { ExplorerOverview } from "./views/ExplorerOverview";
import { AgentsView } from "./views/AgentsView";
import { AgentDetail } from "./views/AgentDetail";
import { RegisterView } from "./views/RegisterView";
import { DecisionsView } from "./views/DecisionsView";
import { DecisionView } from "./views/DecisionView";
import { RoutesView } from "./views/RoutesView";
import { NetworksView } from "./views/NetworksView";
import { StocksView } from "./views/StocksView";

// The Solana pages carry web3.js; they load only when one is opened.
const SolanaPages = lazy(() => import("./views/solana/SolanaPages"));
// So do the Stock Token governor's EVM pages, with viem's wallet code.
const EvmPages = lazy(() => import("./views/evm/EvmPages"));

function useHashRoute(): string {
  const [route, setRoute] = useState(window.location.hash || "#/");
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || "#/");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

export default function App() {
  const route = useHashRoute();
  const isApp = route.startsWith("#/app");
  const path = route.slice(5).split("?")[0] || "/";
  const chain = new URLSearchParams(route.split("?")[1] ?? "").get("chain") ?? "base";

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);

  const page = path === "/evm" || path.startsWith("/evm/")
    ? <Suspense fallback={<div className="not-found"><strong>Loading the Robinhood Chain side…</strong></div>}><EvmPages path={path === "/evm" ? "/evm/robinhood-testnet" : path} /></Suspense>
    : path === "/sol" || path.startsWith("/sol/")
    ? <Suspense fallback={<div className="not-found"><strong>Loading the Solana side…</strong></div>}><SolanaPages path={path} /></Suspense>
    : path === "/agents" ? <AgentsView />
    : path === "/agents/new" ? <RegisterView />
    : /^\/agents\/\d+\/manage$/.test(path) ? <AgentDetail id={path.split("/")[2]} manage />
    : /^\/agents\/\d+$/.test(path) ? <AgentDetail id={path.split("/")[2]} />
    : path === "/decisions" ? <DecisionsView />
    : path.startsWith("/decisions/") ? <DecisionView hash={decodeURIComponent(path.slice("/decisions/".length))} />
    : path === "/stocks" ? <StocksView />
    : path === "/routes" ? <RoutesView />
    : path === "/networks" ? <NetworksView />
    : <ExplorerOverview />;

  return <StoreProvider key={chain}>{isApp ? <ExplorerShell route={route}>{page}</ExplorerShell> : <Landing />}</StoreProvider>;
}
