import { useState } from "react";
import { ArrowLeft, Check, Copy, Send } from "lucide-react";
import { explainWalletError } from "../../lib/evm/stocks";
import { PAYOUT_CHAINS, accept, claim, decline, fetchMe, fetchProject, kindLabel, opHref, routeTypedData, usd, type OpMe as Me } from "../../lib/operator";
import { useHub } from "../evm/common";
import { useOp } from "./OperatorPages";
import { ConnectWallet, ExtLink, Status, TxLink, day, when } from "./parts";

const STEPS = ["Applied", "Read", "Offer", "Escrowed", "Delivered", "Paid"];

function stepOf(me: Me): number {
  const d = me.deal;
  if (d?.status === "closed") return STEPS.length + 1; // every step done
  if (me.claims.some((c) => c.status === "paid")) return 5;
  if (me.claims.length) return 5;
  if (d && (d.status === "open" || d.status === "pending_owner")) return 4;
  if (d?.status === "offered") return 3;
  if (me.application.status !== "new") return 2;
  return 1;
}

export function OpMe({ token }: { token: string }) {
  const { data: me, error, reload } = useHub(() => fetchMe(token), [token], 20_000);
  const { data: page } = useHub(() => (me ? fetchProject(me.project.id) : Promise.resolve(null)), [me?.project.id], 0);
  if (error && !me) return <div className="not-found"><strong>This link does not open an application.</strong><p>{error}</p></div>;
  if (!me) return <div className="not-found"><strong>Reading your application…</strong></div>;
  const a = me.application;
  const step = stepOf(me);

  return <>
    <section className="page-intro compact"><div>
      <a className="back-link" href={opHref(`/p/${me.project.id}`)}><ArrowLeft size={13} />{me.project.name}</a>
      <span className="eyebrow">YOUR PRIVATE LINK · {a.task ? kindLabel(a.task.kind).toUpperCase() : "APPLICATION"}</span>
      <h1>{a.task?.title ?? "Your application"}</h1>
      <p>@{a.handle} · paid at <span className="mono op-wrap">{a.wallet}</span> · applied {when(a.applied_at)}</p>
    </div></section>

    <ol className="op-timeline" aria-label="Where this stands">
      {STEPS.map((s, i) => <li key={s} className={i + 1 < step ? "done" : i + 1 === step ? "now" : ""}>{i + 1 < step ? <Check size={13} /> : <span>{i + 1}</span>}{s}</li>)}
    </ol>

    <section className="op-answer">
      <div><span className="eyebrow">THE OPERATOR&rsquo;S ANSWER</span><Status value={me.deal && me.deal.status !== "offered" ? me.deal.status : a.status} /></div>
      <p>{a.reasoning ?? (a.status === "new" ? "Not read yet. The operator reads new applications every minute or so; this page refreshes on its own." : "The owner is deciding this one.")}</p>
    </section>

    {me.deal?.status === "offered" && <Offer me={me} token={token} crossChain={!!page?.budget?.cross_chain} onDone={reload} />}
    {me.deal && ["open", "pending_owner", "closed"].includes(me.deal.status) && <Deal me={me} token={token} onDone={reload} />}
  </>;
}

function Terms({ me }: { me: Me }) {
  const d = me.deal!;
  return (
    <div className="op-terms">
      <div className="op-terms-total"><small>For the whole task</small><strong>{usd(d.amount_usd)}</strong><span>USDC · due {day(d.deadline)}</span></div>
      <ol>{d.milestones.map((m) => <li key={m.index}><strong>{m.title} · {usd(m.amount_usd)}</strong><span>{m.criteria}</span></li>)}</ol>
    </div>
  );
}

function Offer({ me, token, crossChain, onDone }: { me: Me; token: string; crossChain: boolean; onDone: () => void }) {
  const { wallet, networkOf } = useOp();
  const network = networkOf(me.project.network);
  const [where, setWhere] = useState<number>(-1); // -1: on Arc
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const d = me.deal!;

  const go = async () => {
    setErr(null);
    try {
      let route: { domain: number; recipient: string; deadline: number; signature: string } | undefined;
      if (where >= 0) {
        if (!wallet || wallet.account.toLowerCase() !== me.application.wallet.toLowerCase()) return setErr(`Connect the wallet you applied with (${me.application.wallet.slice(0, 8)}…) to sign where you are paid.`);
        setBusy("Sign where you are paid…");
        const t = await routeTypedData(token, where, wallet.account);
        const signature = await wallet.client.signTypedData({
          account: wallet.account,
          domain: t.domain,
          types: t.types,
          primaryType: "Route",
          message: { ...t.message, domain: t.message.domain, nonce: BigInt(t.message.nonce), deadline: BigInt(t.message.deadline) },
        });
        route = { domain: where, recipient: wallet.account, deadline: t.message.deadline, signature };
      }
      setBusy("Escrowing your deal on-chain…");
      const n = await accept(token, route);
      if (n.kind === "escalated") setErr(`The budget contract would not open it (${n.detail}); the owner has been asked.`);
      onDone();
    } catch (e) {
      setErr(explainWalletError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="form-card op-offer">
      <div className="op-apply-head"><div><span className="eyebrow">YOUR OFFER</span><h2>{usd(d.amount_usd)} for {me.application.task?.title ?? "the task"}</h2>
        <p>Open until {d.offer_expires_at ? when(d.offer_expires_at) : "—"}. Accepting escrows the money in the project&rsquo;s budget contract; it is paid as each part is delivered.</p></div></div>
      <Terms me={me} />
      <div className="field">
        <label>Where you are paid</label>
        <div className="op-payout-pick" role="radiogroup">
          <label className={where === -1 ? "on" : ""}><input type="radio" checked={where === -1} onChange={() => setWhere(-1)} /><strong>Arc</strong><span>USDC to {me.application.wallet.slice(0, 8)}…</span></label>
          {crossChain && PAYOUT_CHAINS.map((c) => (
            <label key={c.domain} className={where === c.domain ? "on" : ""}><input type="radio" checked={where === c.domain} onChange={() => setWhere(c.domain)} /><strong>{c.name}</strong><span>through Circle&rsquo;s CCTP</span></label>
          ))}
        </div>
        {where >= 0 && <div className="note">Your wallet signs where you are paid, so nobody else can redirect it. A small forwarding fee comes out of each payment. {network ? <ConnectWallet network={network} onError={setErr} label="Connect the wallet you applied with" /> : null}</div>}
      </div>
      <div className="form-actions">
        <button className="btn btn-gold" disabled={!!busy} onClick={() => void go()}>{busy ?? "Accept the offer"}</button>
        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => void decline(token).then(onDone)}>Decline</button>
        {err ? <span className="form-msg err">{err}</span> : null}
      </div>
    </section>
  );
}

function Deal({ me, token, onDone }: { me: Me; token: string; onDone: () => void }) {
  const d = me.deal!;
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const send = async (milestone: number) => {
    setErr(null);
    const url = (urls[milestone] ?? "").trim();
    if (!/^https?:\/\//.test(url)) return setErr("Paste the link to what you delivered.");
    setBusy(milestone);
    try {
      await claim(token, milestone, url);
      setUrls((u) => ({ ...u, [milestone]: "" }));
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return <>
    <section className="form-card op-deal">
      <div className="op-apply-head"><div><span className="eyebrow">YOUR DEAL</span><h2>{usd(d.amount_usd)} · <Status value={d.status} /></h2>
        <p>{d.status === "closed" ? <>Every part is paid. The escrow {d.tx ? <TxLink href={d.tx_url} value={d.tx} /> : null} is settled.</> : d.status === "pending_owner" ? "It is over what the operator may agree alone, so the owner signs it on-chain. This page updates when they do." : <>Escrowed {d.tx ? <TxLink href={d.tx_url} value={d.tx} /> : null}. Deliver by {day(d.deadline)}; late work is judged until {day(d.lapses_at)}, then the escrow goes back to the budget.</>}</p></div></div>
      {d.status !== "closed" && <div className="op-code">
        <div><small>Put this code in what you deliver</small><strong>{d.claim_code}</strong>
          <span>Anywhere in the post, the PR description, the article or the video&rsquo;s title. It shows the work was made for this deal, so nobody else can claim it.</span></div>
        <button className="btn btn-ghost btn-sm" onClick={() => { void navigator.clipboard?.writeText(d.claim_code); setCopied(true); }}><Copy size={14} />{copied ? "Copied" : "Copy"}</button>
      </div>}
      {me.route && <p className="note">Paid on {me.route.chain} to <span className="mono">{me.route.recipient}</span>, as you signed.</p>}
      <div className="op-milestones">
        {d.milestones.map((m) => {
          const claims = me.claims.filter((c) => c.milestone === m.index);
          const settled = claims.some((c) => c.status === "paid" || c.status === "new" || c.status === "needs_owner");
          return (
            <article key={m.index}>
              <header><strong>{m.title}</strong><span>{usd(m.amount_usd)}</span></header>
              <p>{m.criteria}</p>
              {claims.map((c) => (
                <div key={c.id} className="op-claim">
                  <Status value={c.status} /><ExtLink href={c.url}>{c.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)}</ExtLink>
                  {c.amount_usd !== null && c.status === "paid" ? <strong>{usd(c.amount_usd)}</strong> : null}
                  {c.tx ? <TxLink href={c.tx_url} value={c.tx} /> : null}
                  {c.reasoning ? <p>{c.reasoning}</p> : c.status === "new" ? <p>Checking it now; this page updates on its own.</p> : null}
                </div>
              ))}
              {d.status === "open" && !settled && (
                <div className="op-claim-form">
                  <input value={urls[m.index] ?? ""} onChange={(e) => setUrls((u) => ({ ...u, [m.index]: e.target.value }))} placeholder="https://… the link to what you delivered" />
                  <button className="btn btn-gold btn-sm" disabled={busy === m.index} onClick={() => void send(m.index)}><Send size={14} />{busy === m.index ? "Sending…" : "Claim"}</button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {err ? <p className="form-msg err">{err}</p> : null}
    </section>
    <details className="op-terms-raw"><summary>The exact terms escrowed (their hash is on-chain)</summary><pre>{JSON.stringify(JSON.parse(d.terms), null, 2)}</pre><p className="mono">{d.terms_hash}</p></details>
  </>;
}
