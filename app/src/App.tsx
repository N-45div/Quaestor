import { useEffect, useState } from "react";
import { StoreProvider } from "./state";
import { Landing } from "./views/Landing";
import { ExplorerShell } from "./components/ExplorerShell";
import { ExplorerOverview } from "./views/ExplorerOverview";
import { AgentsView } from "./views/AgentsView";
import { AgentDetail } from "./views/AgentDetail";
import { DecisionsView } from "./views/DecisionsView";
import { DecisionView } from "./views/DecisionView";
import { RoutesView } from "./views/RoutesView";
import { NetworksView } from "./views/NetworksView";

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
  const chain = new URLSearchParams(route.split("?")[1] ?? "").get("chain") ?? "xlayerTestnet";

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);

  const page = path === "/agents" ? <AgentsView />
    : /^\/agents\/\d+\/manage$/.test(path) ? <AgentDetail id={path.split("/")[2]} manage />
    : /^\/agents\/\d+$/.test(path) ? <AgentDetail id={path.split("/")[2]} />
    : path === "/decisions" ? <DecisionsView />
    : path.startsWith("/decisions/") ? <DecisionView hash={decodeURIComponent(path.slice("/decisions/".length))} />
    : path === "/routes" ? <RoutesView />
    : path === "/networks" ? <NetworksView />
    : <ExplorerOverview />;

  return <StoreProvider key={chain}>{isApp ? <ExplorerShell route={route}>{page}</ExplorerShell> : <Landing />}</StoreProvider>;
}
