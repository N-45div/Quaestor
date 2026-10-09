import { useState } from "react";
import { ArrowLeft, Bell, KeyRound, Play } from "lucide-react";
import { chainOf, explainWalletError, readClient } from "../../lib/evm/stocks";
import {
  PAYOUT_GOVERNOR_ABI, answerApplicant, answerClaim, chainRow, closeHeadsUp, fetchOwner, fetchProject, opHref, ownerMessage, runNow, saveSession, savedSession, usd,
  type OpHeadsUp, type OpOwnerView, type OwnerSession,
} from "../../lib/operator";
import { useHub } from "../evm/common";
import { useOp } from "./OperatorPages";
import { ConnectWallet, ExtLink, Status, TxLink, when } from "./parts";

export function OpOwner({ id }: { id: string }) {
  const { wallet, networkOf } = useOp();
  const { data: page } = useHub(() => fetchProject(id), [id], 0);
  const [session, setSession] = useState<OwnerSession | null>(() => savedSession(id));
  const [err, setErr] = useState<string | null>(null);
  const network = page ? networkOf(page.project.network) : undefined;

  const signIn = async () => {
    setErr(null);
    if (!wallet) return setErr("Connect the wallet that owns this project's budget.");
    try {
      const expires = Math.floor(Date.now() / 1000) + 86_400;
      const signature = await wallet.client.signMessage({ account: wallet.account, message: ownerMessage(id, expires) });
      const s = { address: wallet.account, expires, signature };
      await fetchOwner(s, id); // the hub checks it against the governor's owner now, not on the next click
      saveSession(id, s);
      setSession(s);
    } catch (e) {
      setErr(explainWalletError(e));
    }
  };

  if (!page || !network) return <div className="not-found"><strong>Reading the project…</strong></div>;
  if (!session) {
    return <>
      <Intro id={id} name={page.project.name} />
      <section className="manage-area"><div className="manage-notice">
        <KeyRound size={22} />
        <div><h2>Sign in as the owner</h2><p>Your wallet signs one message, with no transaction and no gas. The hub checks it against the owner of the project&rsquo;s budget contract, and it lasts a day in this tab.</p></div>
        <div className="op-signin"><ConnectWallet network={network} onError={setErr} />{wallet ? <button className="btn btn-gold" onClick={() => void signIn()}>Sign in</button> : null}</div>
      </div>{err ? <p className="form-msg err">{err}</p> : null}</section>
    </>;
  }
  return <Dashboard id={id} session={session} onSignOut={() => { saveSession(id, null); setSession(null); }} />;
}

function Intro({ id, name }: { id: string; name: string }) {
  return (
    <section className="page-intro compact"><div>
      <a className="back-link" href={opHref(`/p/${id}`)}><ArrowLeft size={13} />{name}</a>
      <span className="eyebrow">OWNER</span>
      <h1>{name}: the operator&rsquo;s desk</h1>
    </div></section>
  );
}

function Dashboard({ id, session, onSignOut }: { id: string; session: OwnerSession; onSignOut: () => void }) {
  const { wallet, networkOf } = useOp();
  const { data: v, error, reload } = useHub(() => fetchOwner(session, id), [id, session.signature], 20_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (error && !v) return <div className="not-found"><strong>The hub refused the owner view.</strong><p>{error}</p><button className="btn btn-ghost btn-sm" onClick={onSignOut}>Sign in again</button></div>;
  if (!v) return <div className="not-found"><strong>Reading the desk…</strong></div>;
  const network = networkOf(v.project.network)!;

  const act = async (label: string, fn: () => Promise<{ detail?: string } | unknown>) => {
    setBusy(label);
    setMsg(null);
    try {
      const out = (await fn()) as { detail?: string; notices?: { kind: string; detail: string }[] } | undefined;
      setMsg(out?.notices ? (out.notices.length ? out.notices.map((n) => `${n.kind}: ${n.detail}`).join(" · ") : "Nothing new to decide.") : out?.detail ?? "Done.");
      reload();
    } catch (e) {
      setMsg(explainWalletError(e));
    } finally {
      setBusy(null);
    }
  };

  const approveOnChain = (dealId: string) => act("approve", async () => {
    if (!wallet || wallet.account.toLowerCase() !== session.address.toLowerCase()) throw new Error("Connect the owner wallet to sign the approval.");
    const hash = await wallet.client.writeContract({ address: v.project.governor, abi: PAYOUT_GOVERNOR_ABI, functionName: "approveDeal", args: [dealId as `0x${string}`], account: wallet.account, chain: chainOf(chainRow(network)) });
    await readClient(chainRow(network)).waitForTransactionReceipt({ hash });
    return runNow(session, id); // the operator sees the approval and opens the deal
  });

  const b = v.budget;
  return <>
    <Intro id={id} name={v.project.name} />
    <section className="op-budget" aria-label="Budget">
      <div><small>Free to commit</small><strong>{usd(b.free_usd)}</strong></div>
      <div><small>In escrow</small><strong>{usd(b.escrowed_usd)}</strong></div>
      <div><small>Paid this period</small><strong>{usd(b.paid_this_period_usd)}</strong><span>of {usd(b.period_cap_usd)} every {b.period_days} days</span></div>
      <div><small>Limits</small><strong>{usd(b.per_deal_cap_usd)}</strong><span>a deal · {usd(b.new_payee_cap_usd)} for someone new · {b.new_payees_per_period} new a period</span></div>
      <div><small>Operator</small><strong>{v.deciding ? "Deciding" : "Not deciding"}</strong><span>{b.suspended ? "Budget suspended" : v.deciding ? (v.model ? `${v.model}, every minute` : "Every minute") : "No model on this hub"}</span></div>
    </section>
    <div className="form-actions op-desk-actions">
      <button className="btn btn-gold btn-sm" disabled={!!busy} onClick={() => void act("run", () => runNow(session, id))}><Play size={14} />{busy === "run" ? "Running…" : "Run the operator now"}</button>
      {!wallet ? <ConnectWallet network={network} onError={setMsg} label="Connect the owner wallet" /> : null}
      <button className="btn btn-ghost btn-sm" onClick={onSignOut}>Sign out</button>
      {msg ? <span className="form-msg">{msg}</span> : null}
    </div>

    <section className="data-section">
      <div className="section-heading"><div><span className="eyebrow"><Bell size={12} /> HEADS-UPS</span><h2>Waiting on you</h2></div><span className="row-count">{v.heads_ups.length} open</span></div>
      <div className="op-headsups">
        {v.heads_ups.map((h) => <HeadsUp key={h.id} h={h} busy={!!busy}
          approve={() => void approveOnChain(h.subject)}
          applicant={(action) => void act(action, () => answerApplicant(session, id, h.subject, action))}
          pay={(f) => void act("pay", () => answerClaim(session, id, h.subject, f))}
          close={(s) => void act("close", () => closeHeadsUp(session, id, h.id, s))} />)}
        {!v.heads_ups.length && <p className="muted-copy">Nothing needs you. The operator is inside its limits.</p>}
      </div>
    </section>

    <Tables v={v} explorer={network.explorer} />
  </>;
}

function HeadsUp({ h, busy, approve, applicant, pay, close }: {
  h: OpHeadsUp; busy: boolean; approve: () => void; applicant: (a: "rescreen" | "reject") => void; pay: (fraction: number) => void; close: (s: "done" | "dismissed") => void;
}) {
  const [headline, ...rest] = h.text.split("\n\n");
  return (
    <article className={`op-headsup ${h.kind}`}>
      <header><span>{h.kind === "brief" ? "Weekly brief" : h.kind === "approve_deal" ? "Approve a deal" : h.kind === "screen" ? "An application" : "A delivery"}</span><small>{when(h.created_at)}</small></header>
      <p><strong>{headline}</strong></p>
      {rest.map((r, i) => <p key={i}>{r}</p>)}
      <div className="form-actions">
        {h.kind === "approve_deal" && <button className="btn btn-gold btn-sm" disabled={busy} onClick={approve}>Approve on-chain</button>}
        {h.kind === "screen" && <><button className="btn btn-gold btn-sm" disabled={busy} onClick={() => applicant("rescreen")}>Screen it again</button><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => applicant("reject")}>Turn it down</button></>}
        {(h.kind === "claim" || h.kind === "refused") && /^[0-9a-f-]{36}$/.test(h.subject) && <>
          <button className="btn btn-gold btn-sm" disabled={busy} onClick={() => pay(1)}>Pay in full</button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => pay(0.5)}>Pay half</button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => pay(0)}>Don&rsquo;t pay</button>
        </>}
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => close(h.kind === "brief" ? "done" : "dismissed")}>{h.kind === "brief" ? "Read" : "Dismiss"}</button>
      </div>
    </article>
  );
}

function Tables({ v, explorer }: { v: OpOwnerView; explorer: string }) {
  const handleOf = (wallet: unknown) => v.applicants.find((a) => a.wallet.toLowerCase() === String(wallet).toLowerCase())?.handle;
  const reason = (r: Record<string, unknown>) => r.kind === "open_deal"
    ? `Escrowed ${usd(Number(r.amount) / 1e6)} for @${handleOf(r.payee) ?? String(r.payee).slice(0, 10)}, against the terms' hash`
    : String(r.reasoning ?? r.headline ?? (Array.isArray(r.checked) && r.checked.length ? (r.checked as string[]).join("; ") : r.action ?? ""));
  return <>
    <section className="data-section">
      <div className="section-heading"><div><span className="eyebrow">PEOPLE</span><h2>Applications</h2></div><span className="row-count">{v.applicants.length}</span></div>
      <div className="explorer-table-wrap"><table className="explorer-table">
        <thead><tr><th>Who</th><th>Task</th><th>Status</th><th>Fit</th><th>Pitch</th><th>Work</th></tr></thead>
        <tbody>{v.applicants.map((a) => (
          <tr key={a.id}><td>@{a.handle}</td><td>{a.task.replace(`${v.project.id}-`, "")}</td><td><Status value={a.status} /></td><td className="numeric">{a.score ?? "—"}</td>
            <td className="op-cell-text">{a.pitch.slice(0, 160)}{a.pitch.length > 160 ? "…" : ""}</td>
            <td>{a.samples.slice(0, 2).map((s) => <ExtLink key={s} href={s}>{s.replace(/^https?:\/\/(www\.)?/, "").slice(0, 26)}</ExtLink>)}</td></tr>
        ))}{!v.applicants.length && <tr><td className="table-empty" colSpan={6}>No applications yet. Share the project page.</td></tr>}</tbody>
      </table></div>
    </section>

    <section className="data-section">
      <div className="section-heading"><div><span className="eyebrow">MONEY</span><h2>Deals and deliveries</h2></div></div>
      <div className="explorer-table-wrap"><table className="explorer-table">
        <thead><tr><th>Who</th><th>Deal</th><th>Status</th><th>Delivered</th><th>Claim</th><th>Paid</th><th>Payment</th></tr></thead>
        <tbody>{v.claims.map((c) => {
          const d = v.deals.find((x) => x.id === c.deal);
          return <tr key={c.id}><td>@{c.handle}</td><td className="numeric">{usd(d?.amount_usd)}</td><td>{d ? <Status value={d.status} /> : "—"}</td>
            <td><ExtLink href={c.url}>{c.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 34)}</ExtLink></td><td><Status value={c.status} /></td>
            <td className="numeric">{usd(c.amount_usd)}</td><td>{c.tx ? <TxLink href={`${explorer}/tx/${c.tx}`} value={c.tx} /> : "—"}</td></tr>;
        })}
        {v.deals.filter((d) => !v.claims.some((c) => c.deal === d.id)).map((d) => (
          <tr key={d.id}><td>@{d.handle ?? d.payee.slice(0, 8)}</td><td className="numeric">{usd(d.amount_usd)}</td><td><Status value={d.status} /></td><td colSpan={4} className="muted-cell">Nothing delivered yet · due {when(d.deadline)}</td></tr>
        ))}
        {!v.deals.length && <tr><td className="table-empty" colSpan={7}>No deals yet.</td></tr>}</tbody>
      </table></div>
    </section>

    <section className="data-section">
      <div className="section-heading"><div><span className="eyebrow">THE RECORD</span><h2>Every decision, and why</h2></div><span className="row-count">hashes ride on-chain with the action</span></div>
      <div className="explorer-table-wrap"><table className="explorer-table">
        <thead><tr><th>When</th><th>Decision</th><th>Why</th><th>Hash</th></tr></thead>
        <tbody>{v.decisions.map((d) => (
          <tr key={d.hash}><td>{when(d.at)}</td><td>{d.kind.replace("_", " ")}{typeof d.record.decision === "string" ? ` · ${d.record.decision}` : ""}</td>
            <td className="op-cell-text">{reason(d.record).slice(0, 220)}</td>
            <td>{["open_deal", "verify", "owner_verify"].includes(d.kind) ? <a className="mono-link" href={opHref(`/d/${d.hash}`)}>{d.hash.slice(0, 10)}…</a> : <span className="mono" title="Private to you and the applicant">{d.hash.slice(0, 10)}…</span>}</td></tr>
        ))}</tbody>
      </table></div>
    </section>

    <section className="data-section">
      <div className="section-heading"><div><span className="eyebrow">TRACK RECORDS</span><h2>Who delivered</h2></div></div>
      <div className="explorer-table-wrap"><table className="explorer-table">
        <thead><tr><th>Who</th><th>Delivered</th><th>Late</th><th>Refused</th><th>Quality</th><th>Paid</th></tr></thead>
        <tbody>{v.payees.map((p) => (
          <tr key={p.payee}><td>{p.handle ? `@${p.handle}` : p.payee.slice(0, 10)}</td><td className="numeric">{p.delivered}</td><td className="numeric">{p.late}</td><td className="numeric">{p.rejected}</td>
            <td className="numeric">{p.quality === null ? "—" : `${p.quality.toFixed(1)} / 5`}</td><td className="numeric">{usd(p.paid_usd)}</td></tr>
        ))}{!v.payees.length && <tr><td className="table-empty" colSpan={6}>Nobody paid yet.</td></tr>}</tbody>
      </table></div>
    </section>
  </>;
}
