import { ArrowRight, Clock3, Database, ShieldCheck, Waypoints } from "lucide-react";
import { explorerHref } from "../../components/ExplorerShell";
import { timeAgo } from "../../lib/format";
import { STOCKS_PROGRAM_ID } from "../../lib/solana/program";
import { shortKey } from "../../lib/solana/chain";
import { useSolana } from "../../lib/solana/store";
import { agentLabel, SolanaTradesTable, usdc } from "./common";
import { SolanaRefusals } from "./SolanaRefusals";
import { CurvePanels } from "../../components/CurvePanel";
import { stocksBase } from "../../lib/stocks";

export function SolanaOverview() {
  const { governors, trades, ready, error } = useSolana();
  const able = governors.filter((g) => !g.suspended && (g.vaultBalance ?? 0n) > 0n);
  const treasury = governors.reduce((sum, g) => sum + (g.vaultBalance ?? 0n), 0n);
  const recent = trades.filter((t) => t.settledAt > Date.now() - 86_400_000);
  const recentSpend = recent.reduce((sum, t) => sum + t.amountSpent, 0n);
  const latest = trades[0];
  const counts = new Map<string, number>();
  trades.forEach((t) => counts.set(t.governor, (counts.get(t.governor) ?? 0) + 1));
  const [busiestAddress, busiestCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  const busiest = governors.find((g) => g.address === busiestAddress);

  return <>
    <section className="page-intro overview-intro">
      <div>
        <span className="eyebrow">LIVE ON SOLANA DEVNET</span>
        <h1>Stock agents under a program&rsquo;s limits.</h1>
        <p>Every governor on the Quaestor program, what its vault holds, and every trade it settled, read straight from devnet. No indexer stands between this page and the chain.</p>
      </div>
      <div className="network-pulse"><span className={ready && !error ? "pulse-live" : "pulse-warn"} /><div><strong>{ready && !error ? "Devnet responding" : error ? "Devnet not answering" : "Reading devnet"}</strong><small>Program {shortKey(STOCKS_PROGRAM_ID.toBase58())}</small></div></div>
    </section>

    <section className="metric-grid">
      <article><span className="metric-icon"><ShieldCheck /></span><div className="metric-label">Governed agents</div><div className="metric-value">{ready ? governors.length : "—"}</div><div className="metric-foot">{ready ? <><b>{able.length}</b> funded and able to trade</> : "Reading chain state"}</div></article>
      <article><span className="metric-icon"><Database /></span><div className="metric-label">Test USDC under policy</div><div className="metric-value metric-money">{ready ? usdc(treasury) : "—"}</div><div className="metric-foot">In governor vaults</div></article>
      <article><span className="metric-icon"><Waypoints /></span><div className="metric-label">Trades · 24 hours</div><div className="metric-value">{ready ? recent.length : "—"}</div><div className="metric-foot">{usdc(recentSpend)} USDC spent</div></article>
      <article><span className="metric-icon"><Clock3 /></span><div className="metric-label">Latest settlement</div><div className="metric-value metric-time">{latest ? timeAgo(latest.settledAt) : "—"}</div><div className="metric-foot">{latest ? `${trades.length} trades on chain` : "No settled trades"}</div></article>
    </section>

    <section className="overview-split">
      <div className="routing-panel">
        <span className="eyebrow">BRING YOUR AGENT</span><h2>Your agent, your vault, your limits</h2>
        <p className="muted-copy">Any wallet can open a governor of its own on this program: its own vault, its own caps, its own agent key. The agent can trade inside the caps and nothing else.</p>
        <a className="text-cta" href={explorerHref("/sol/register")}>Register an agent on devnet <ArrowRight size={15} /></a>
      </div>
      <div className="leader-panel">
        <span className="eyebrow">MOST ACTIVE</span>
        {busiest ? <>
          <h2>{agentLabel(busiest)}</h2>
          <div className="leader-id">{shortKey(busiest.address)}</div>
          <div className="leader-count">{busiestCount} <span>settled trades</span></div>
          <a className="text-cta" href={explorerHref(`/sol/agents/${busiest.address}`)}>Open agent record <ArrowRight size={15} /></a>
        </> : <p className="muted-copy">Activity will appear after the first settled trade.</p>}
      </div>
    </section>

    {error && <div className="data-warning"><span>{error}. The page keeps trying every 20 seconds.</span></div>}
    {/* From the hub, not the chain: it reads both pools on its own clock. */}
    <CurvePanels base={stocksBase()} />
    <SolanaRefusals />
    <SolanaTradesTable rows={trades} limit={12} />
  </>;
}
