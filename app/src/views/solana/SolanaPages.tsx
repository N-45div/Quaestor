import { SolanaStoreProvider } from "../../lib/solana/store";
import { SolanaOverview } from "./SolanaOverview";
import { SolanaAgents } from "./SolanaAgents";
import { SolanaAgent } from "./SolanaAgent";
import { SolanaTrades } from "./SolanaTrades";
import { SolanaRegister } from "./SolanaRegister";

/**
 * Every /sol page, loaded on its own: web3.js and the program client arrive
 * only when someone opens the Solana side, not with the landing page. The
 * pages share one store, which reads devnet while any of them is open.
 */
export default function SolanaPages({ path }: { path: string }) {
  const page = path === "/sol" ? <SolanaOverview />
    : path === "/sol/agents" ? <SolanaAgents />
    : path.startsWith("/sol/agents/") ? <SolanaAgent address={decodeURIComponent(path.slice("/sol/agents/".length))} />
    : path === "/sol/trades" ? <SolanaTrades />
    : path === "/sol/register" ? <SolanaRegister />
    : <div className="not-found"><strong>No such Solana page.</strong><a href="#/app/sol">Solana overview</a></div>;
  return <SolanaStoreProvider>{page}</SolanaStoreProvider>;
}
