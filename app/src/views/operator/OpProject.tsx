import { useState } from "react";
import { ArrowLeft, Copy, Send } from "lucide-react";
import { apply, fetchProject, kindLabel, opHref, usd, type OpProjectPage, type OpTask } from "../../lib/operator";
import { useHub } from "../evm/common";
import { useOp } from "./OperatorPages";
import { ConnectWallet, ExtLink, TxLink, day } from "./parts";

export function OpProject({ id }: { id: string }) {
  const { data, error } = useHub(() => fetchProject(id), [id], 30_000);
  const [applying, setApplying] = useState<OpTask | null>(null);
  if (error && !data) return <div className="not-found"><strong>No such project.</strong><p>{error}</p></div>;
  if (!data) return <div className="not-found"><strong>Reading the project…</strong></div>;
  const { project, tasks, budget, totals, payments } = data;

  return <>
    <section className="page-intro compact"><div>
      <a className="back-link" href={opHref("")}><ArrowLeft size={13} />Quaestor Operator</a>
      <span className="eyebrow">PAID WORK · {project.network.toUpperCase()}</span>
      <h1>{project.name}</h1>
      <div className="op-brief">{project.brief.split(/\n\n+/).map((para, i) => <p key={i}>{para}</p>)}</div>
      <div className="op-links">{project.links.map((l) => <ExtLink key={l} href={l}>{l.replace(/^https?:\/\//, "").replace(/\/$/, "")}</ExtLink>)}</div>
    </div></section>

    {budget && (
      <section className="op-budget" aria-label="Budget">
        <div><small>Free to commit</small><strong>{usd(budget.free_usd)}</strong></div>
        <div><small>In escrow</small><strong>{usd(budget.escrowed_usd)}</strong></div>
        <div><small>Paid so far</small><strong>{usd(totals.paid_usd)}</strong><span>{totals.paid_deliveries} {totals.paid_deliveries === 1 ? "delivery" : "deliveries"}</span></div>
        <div><small>Most per deal</small><strong>{usd(budget.per_deal_cap_usd)}</strong><span>{usd(budget.new_payee_cap_usd)} for someone new</span></div>
        <div><small>Budget contract</small>{project.governor ? <TxLink href={project.governor_url} value={project.governor} /> : "—"}<span>{budget.suspended ? "Suspended by its owner" : budget.cross_chain ? "Pays on Arc, or on your chain" : "Pays on Arc"}</span></div>
      </section>
    )}

    <section className="data-section">
      <div className="section-heading"><div><span className="eyebrow">OPEN TASKS</span><h2>What it pays for</h2></div><span className="row-count">{tasks.length} open</span></div>
      <div className="op-tasks">
        {tasks.map((t) => (
          <article key={t.id} className="op-task">
            <header><span className="op-kind">{kindLabel(t.kind)}</span><span className="op-rate">{usd(t.rate_min_usd)}–{usd(t.rate_max_usd)}</span></header>
            <h3>{t.title}</h3>
            <p>{t.done_when}</p>
            <footer><span>{t.slots_left} of {t.slots} places left</span>
              <button className="btn btn-gold btn-sm" disabled={!t.slots_left} onClick={() => setApplying(t)}>{t.slots_left ? "Apply" : "Full"}</button></footer>
          </article>
        ))}
      </div>
    </section>

    {applying && <ApplyForm project={data} task={applying} onClose={() => setApplying(null)} />}

    <section className="data-section">
      <div className="section-heading"><div><span className="eyebrow">ON-CHAIN</span><h2>What it paid for</h2></div><span className="row-count">every payment with the record of why</span></div>
      <div className="explorer-table-wrap">
        <table className="explorer-table">
          <thead><tr><th>Who</th><th>Delivered</th><th>Paid</th><th>Why</th><th>Payment</th><th>When</th></tr></thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.tx}>
                <td>@{p.handle}</td>
                <td><ExtLink href={p.proof_url}>{p.proof_url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 42)}</ExtLink></td>
                <td className="numeric">{usd(p.amount_usd)}</td>
                <td>{p.decision ? <a className="mono-link" href={opHref(`/d/${p.decision}`)}>the record</a> : "—"}</td>
                <td><TxLink href={p.tx_url} value={p.tx} /></td>
                <td>{day(p.at)}</td>
              </tr>
            ))}
            {!payments.length && <tr><td className="table-empty" colSpan={6}>Nothing paid yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  </>;
}

function ApplyForm({ project, task, onClose }: { project: OpProjectPage; task: OpTask; onClose: () => void }) {
  const { wallet, networkOf } = useOp();
  const network = networkOf(project.project.network);
  const [handle, setHandle] = useState("");
  const [address, setAddress] = useState("");
  const [email, setEmail] = useState("");
  const [pitch, setPitch] = useState("");
  const [samples, setSamples] = useState(["", "", ""]);
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const payTo = address || (wallet?.account ?? "");
  const link = done ? `${window.location.origin}${window.location.pathname}${opHref(`/me/${done}`)}` : "";

  const send = async () => {
    setErr(null);
    if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) return setErr("Connect your wallet, or paste the address you want to be paid at.");
    if (!handle.trim()) return setErr(task.kind === "pull-request" ? "Your GitHub username." : task.kind === "video" ? "Your YouTube channel name." : "Your handle.");
    if (pitch.trim().length < 20) return setErr("Say a little more: why you, and what you would make.");
    setBusy(true);
    try {
      const out = await apply(project.project.id, {
        taskId: task.id, handle: handle.trim(), wallet: payTo, email: email.trim() || undefined, pitch: pitch.trim(),
        samples: samples.map((s) => s.trim()).filter(Boolean), askedRateUsd: rate ? Number(rate) : undefined,
      });
      setDone(out.token);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <section className="form-card op-apply" aria-live="polite">
        <div className="success-head">✓ Applied for “{task.title}”.</div>
        <p className="success-sub">This link is yours alone: your application, the operator&rsquo;s answer, your offer, your deal and your payments. Keep it; there is no other way back to it.</p>
        <div className="op-private-link"><code>{link}</code><button className="btn btn-ghost btn-sm" onClick={() => void navigator.clipboard?.writeText(link)}><Copy size={14} />Copy</button></div>
        <div className="form-actions"><a className="btn btn-gold btn-sm" href={opHref(`/me/${done}`)}>Open my link</a></div>
      </section>
    );
  }
  const handleLabel = task.kind === "pull-request" ? "GitHub username" : task.kind === "video" ? "YouTube channel" : task.kind === "article" ? "Your name or handle" : "X handle";
  return (
    <section className="form-card op-apply">
      <div className="op-apply-head"><div><span className="eyebrow">APPLY</span><h2>{task.title}</h2><p>{usd(task.rate_min_usd)}–{usd(task.rate_max_usd)} · {task.done_when}</p></div><button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button></div>
      <div className="form-grid">
        <div className="field"><label htmlFor="op-handle">{handleLabel}</label><input id="op-handle" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder={task.kind === "pull-request" ? "octocat" : "@you"} /><div className="note">What you deliver must be published by this account.</div></div>
        <div className="field"><label htmlFor="op-wallet">Paid at</label>
          <input id="op-wallet" value={payTo} onChange={(e) => setAddress(e.target.value.trim())} placeholder="0x… your wallet" />
          <div className="note">{network ? <>Or <ConnectWallet network={network} onError={setErr} label="use my wallet" /></> : null} You choose a chain to be paid on when you accept.</div></div>
        <div className="field" style={{ gridColumn: "1 / -1" }}><label htmlFor="op-pitch">Why you, and what you would make</label>
          <textarea id="op-pitch" rows={4} value={pitch} onChange={(e) => setPitch(e.target.value)} maxLength={2000} placeholder="Who you reach, what you would say, and why it would be worth it to them." /></div>
        <div className="field" style={{ gridColumn: "1 / -1" }}><label>Work you have done (links)</label>
          <div className="op-samples">{samples.map((s, i) => <input key={i} value={s} onChange={(e) => setSamples((x) => x.map((y, j) => (j === i ? e.target.value : y)))} placeholder={i === 0 ? "https://x.com/you/status/…" : "another link (optional)"} />)}</div>
          <div className="note">The operator reads them: the best evidence is work like this task, for an audience like this project&rsquo;s.</div></div>
        <div className="field"><label htmlFor="op-rate">Your rate, if you have one (USD)</label><input id="op-rate" value={rate} onChange={(e) => setRate(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder={`${task.rate_min_usd}–${task.rate_max_usd}`} /></div>
        <div className="field"><label htmlFor="op-email">Email (optional)</label><input id="op-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Only to tell you about this application" /></div>
      </div>
      <div className="form-actions">
        <button className="btn btn-gold" disabled={busy} onClick={() => void send()}><Send size={15} />{busy ? "Sending…" : "Apply"}</button>
        {err ? <span className="form-msg err">{err}</span> : <span className="form-msg">An AI operator reads every application. It answers on your private link, usually within minutes.</span>}
      </div>
    </section>
  );
}
