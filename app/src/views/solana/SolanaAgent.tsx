import { useEffect, useState } from "react";
import { ArrowLeft, WalletCards } from "lucide-react";
import { PublicKey } from "@solana/web3.js";
import { explorerHref } from "../../components/ExplorerShell";
import { MINT_NAMES, STOCK_MINTS, VENUE_NAMES } from "../../lib/solana/devnet";
import { readApprovals, readPositions, shortKey, units, type ApprovalsView, type PositionView } from "../../lib/solana/chain";
import { useSolana } from "../../lib/solana/store";
import { KeyLink, SolanaTradesTable, agentLabel, liveEpoch, usdc } from "./common";
import { SolanaOwnerControls } from "./SolanaOwnerControls";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One governor: who owns it, which key trades for it, its caps, its vault, what it may buy and what it holds. */
export function SolanaAgent({ address }: { address: string }) {
  const { conn, governors, trades, ready } = useSolana();
  const g = governors.find((x) => x.address === address);
  const [approvals, setApprovals] = useState<ApprovalsView | null>(null);
  const [positions, setPositions] = useState<PositionView[] | null>(null);
  // A read the public endpoint refused is tried again, not left "reading" for good.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!g) return;
    let live = true;
    let retry: number | undefined;
    const governor = new PublicKey(g.address);
    (async () => {
      const a = await readApprovals(conn, governor);
      if (!live) return;
      setApprovals(a);
      // The known tokens as well as the allowed ones: a token the owner has
      // since revoked can still be held, and still be taken out.
      const p = await readPositions(conn, governor, [...new Set([...a.instruments, ...STOCK_MINTS])]);
      if (live) setPositions(p);
    })().catch(() => { if (live) retry = window.setTimeout(() => setAttempt((n) => n + 1), 5_000); });
    return () => { live = false; window.clearTimeout(retry); };
  }, [conn, g?.address, trades.length, attempt]);

  if (!ready) return <div className="not-found"><strong>Reading governor {shortKey(address)}…</strong><p>Fetching its owner, agent key, caps and vault from devnet.</p></div>;
  if (!g) return <div className="not-found"><strong>No governor at {shortKey(address)}.</strong><p>It may not exist on this program, or devnet has not answered yet.</p><a href={explorerHref("/sol/agents")}>Back to agents</a></div>;

  const label = agentLabel(g);
  const mine = trades.filter((t) => t.governor === g.address);
  const { epoch, spent } = liveEpoch(g);
  const pct = g.epochCap ? Number((spent * 100n) / g.epochCap) : 0;
  const epochEnds = (Number(epoch) + 1) * Number(g.epochLength) * 1000;

  return <>
    <a className="back-link" href={explorerHref("/sol/agents")}><ArrowLeft size={15} />All agents</a>
    <section className="agent-hero">
      <div className="agent-avatar large">{label.slice(0, 1)}</div>
      <div className="agent-title"><span className="eyebrow">GOVERNOR · SOLANA DEVNET</span><h1>{label}</h1><div className="identity-line">{g.suspended ? <span className="state-badge suspended">Suspended</span> : <span className="state-badge live">Active</span>}<KeyLink value={g.address} /></div></div>
    </section>

    <section className="detail-grid">
      <article className="identity-card"><span className="eyebrow">AUTHORITY</span><dl>
        <div><dt>Owner</dt><dd><KeyLink value={g.owner.toBase58()} /> <small className="dim">sets caps, allows venues and tokens, suspends, withdraws</small></dd></div>
        <div><dt>Agent key</dt><dd><KeyLink value={g.operator.toBase58()} /> <small className="dim">can only trade, inside the caps</small></dd></div>
        <div><dt>Epoch</dt><dd>#{epoch.toString()} · {Number(g.epochLength) / 3600} h each · the next starts {new Date(epochEnds).toLocaleString()}</dd></div>
      </dl></article>
      <article className="treasury-card"><span className="eyebrow">VAULT</span><div className="big-balance">{usdc(g.vaultBalance)} USDC</div><p>Test USDC the agent can spend, and only through a trade the program checks.</p><WalletCards size={46} /></article>
    </section>

    <section className="policy-section">
      <div className="section-heading"><div><span className="eyebrow">OWNER-SET LIMITS</span><h2>What the agent may spend</h2></div><span className="row-count">Epoch {epoch.toString()}</span></div>
      <div className="policy-grid">
        <article><div className="policy-top"><span className="purpose purpose-execution">Per trade</span><strong>{usdc(g.perTradeCap)} USDC</strong></div><p className="muted-copy">The most one trade may take from the vault.</p></article>
        <article><div className="policy-top"><span className="purpose purpose-execution">This epoch</span><strong>{Math.min(pct, 100)}%</strong></div><div className="policy-meter"><span className="execution" style={{ width: `${Math.min(pct, 100)}%` }} /></div><p className="muted-copy">{usdc(spent)} of {usdc(g.epochCap)} USDC spent.</p></article>
        <article><div className="policy-top"><span className="purpose purpose-data">Allowed</span><strong>{approvals ? `${plural(approvals.venues.length, "venue")} · ${plural(approvals.instruments.length, "token")}` : "…"}</strong></div>
          <p className="muted-copy">{approvals ? <>{approvals.venues.map((v) => VENUE_NAMES[v.program] ?? v.label ?? shortKey(v.program)).join(", ") || "No venue"}{" · "}{approvals.instruments.map((m) => MINT_NAMES[m] ?? shortKey(m)).join(", ") || "No token"}</> : "Reading allowlists…"}</p></article>
      </div>
    </section>

    <SolanaOwnerControls g={g} positions={positions} onChanged={() => setAttempt((n) => n + 1)} />

    <section className="data-section">
      <div className="section-heading"><div><span className="eyebrow">HOLDINGS</span><h2>What the governor has bought</h2></div><span className="row-count">Held by the program</span></div>
      <div className="explorer-table-wrap"><table className="explorer-table">
        <thead><tr><th>Token</th><th>Amount</th><th>Account</th></tr></thead>
        <tbody>
          {(positions ?? []).map((p) => <tr key={p.account}><td>{MINT_NAMES[p.mint] ?? shortKey(p.mint)}</td><td className="numeric">{units(p.amount, p.decimals, 6)}</td><td><KeyLink value={p.account} /></td></tr>)}
          {positions && !positions.length && <tr><td colSpan={3} className="table-empty">Nothing bought yet.</td></tr>}
          {!positions && <tr><td colSpan={3} className="table-empty">Reading positions…</td></tr>}
        </tbody>
      </table></div>
      <p className="muted-copy">Bought tokens stay in accounts the program controls until the owner takes them out. The agent's key cannot move them, and the program has no instruction that sells them yet.</p>
    </section>

    <SolanaTradesTable rows={mine} title={`${label} trades`} />
  </>;
}
