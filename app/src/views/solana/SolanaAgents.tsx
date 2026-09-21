import { ArrowRight, Plus } from "lucide-react";
import { explorerHref } from "../../components/ExplorerShell";
import { timeAgo } from "../../lib/format";
import { shortKey } from "../../lib/solana/chain";
import { useSolana } from "../../lib/solana/store";
import { agentLabel, liveEpoch, usdc } from "./common";

/** Every governor on the program. One wallet owns one governor, and one governor is one agent. */
export function SolanaAgents() {
  const { governors, trades, ready } = useSolana();
  return <>
    <section className="page-intro compact"><div><span className="eyebrow">AGENT DIRECTORY · SOLANA DEVNET</span><h1>Agents</h1><p>Every governor on the Quaestor program. Each is one owner wallet, one vault and one agent key, with the caps the owner set.</p></div></section>
    <div className="list-toolbar"><span>{governors.length} governors on chain</span><a className="btn btn-gold btn-sm register-cta" href={explorerHref("/sol/register")}><Plus size={14} />Register your agent</a></div>
    <section className="data-section flush">
      <div className="explorer-table-wrap"><table className="explorer-table agents-table">
        <thead><tr><th>Agent</th><th>Status</th><th>Owner</th><th>Vault</th><th>Epoch use</th><th>Last trade</th><th /></tr></thead>
        <tbody>
          {governors.map((g) => {
            const mine = trades.filter((t) => t.governor === g.address);
            const spent = liveEpoch(g).spent;
            const pct = g.epochCap ? Number((spent * 100n) / g.epochCap) : 0;
            const label = agentLabel(g);
            return <tr key={g.address}>
              <td><a className="agent-cell" href={explorerHref(`/sol/agents/${g.address}`)}><span className="agent-avatar">{label.slice(0, 1)}</span><span><strong>{label}</strong><small>{shortKey(g.address)} · {mine.length} trades</small></span></a></td>
              <td>{g.suspended ? <span className="state-badge suspended">Suspended</span> : <span className="state-badge live">Active</span>}</td>
              <td className="mono-muted" title={g.owner.toBase58()}>{shortKey(g.owner.toBase58())}</td>
              <td className="numeric">{usdc(g.vaultBalance)} USDC</td>
              <td><div className="mini-meter"><span style={{ width: `${Math.min(pct, 100)}%` }} /></div><small>{usdc(spent)} of {usdc(g.epochCap)} USDC</small></td>
              <td>{mine[0] ? <strong>{timeAgo(mine[0].settledAt)}</strong> : <span className="dim">No trades yet</span>}</td>
              <td><a className="row-arrow" href={explorerHref(`/sol/agents/${g.address}`)} aria-label={`Open ${label}`}><ArrowRight size={16} /></a></td>
            </tr>;
          })}
          {!ready && <tr><td colSpan={7} className="table-empty">Reading governors from devnet…</td></tr>}
          {ready && !governors.length && <tr><td colSpan={7} className="table-empty">No governor exists on this program yet.</td></tr>}
        </tbody>
      </table></div>
    </section>
  </>;
}
