import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Check, Send, X } from "lucide-react";
import { fetchChat, handDraft, kindLabel, opHref, sendChat, type ChatCard, type ChatRole, type ChatTranscript } from "../../lib/operator";

/**
 * Talk to the Operator. A business says what it wants promoted and gets a drafted project, matched creators and a
 * live quote for funding it from BTC on Mezo; a creator builds a profile, proves their handles and finds paid work.
 * The conversation lives on the hub; this tab remembers which one is yours.
 */
type Entry = ChatTranscript["log"][number];

const SESSION_KEY = (role: ChatRole) => `quaestor-operator-chat:${role}`;
const CREATOR_KEY = "quaestor-operator-creator";
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private window */ } };

const STARTERS: Record<ChatRole, string[]> = {
  business: [
    "I run a Bitcoin savings app on Mezo and want a few X posts explaining how to borrow MUSD against BTC with it, about 100 MUSD in all.",
    "We need a YouTube walkthrough and two threads about our Mezo wallet, budget around 300 MUSD.",
  ],
  creator: [
    "I write X threads about Bitcoin DeFi. Pay me in MUSD on Mezo, usually $20 to $50 a thread.",
    "I make short YouTube tutorials on DeFi apps. What can I apply to?",
  ],
};

/** The model writes **bold** now and then; show it as bold, as text nodes only, never as HTML. */
function Prose({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (/^\*\*[^*]+\*\*$/.test(part) ? <b key={i}>{part.slice(2, -2)}</b> : <span key={i}>{part}</span>))}</>;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const btc = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 5 })} BTC`;

function Card({ card, say }: { card: ChatCard; say: (m: string) => void }) {
  switch (card.type) {
    case "project_draft": {
      const d = card.draft;
      return (
        <div className="op-chat-card">
          <header><span className="eyebrow">DRAFT · {d.network.toUpperCase()} · {d.token}</span><strong>{d.name}</strong></header>
          <p className="op-chat-brief">{d.brief}</p>
          <ul className="op-chat-tasks">{d.tasks.map((t, i) => (
            <li key={i}><span className="op-kind">{kindLabel(t.kind)}</span><b>{t.title}</b><span>{usd(t.rate_min_usd)}–{usd(t.rate_max_usd)} × {t.slots}</span><small>{t.done_when}</small></li>
          ))}</ul>
          <footer><span>Budget {usd(card.total_min_usd)}–{usd(card.total_max_usd)} in {d.token}</span>
            <button className="btn btn-gold btn-sm" onClick={() => { handDraft(d); window.location.hash = opHref("/new"); }}>Open this budget with your wallet</button></footer>
        </div>
      );
    }
    case "creator_matches":
      return (
        <div className="op-chat-card">
          <header><span className="eyebrow">MATCHED CREATORS</span><strong>{card.task}</strong></header>
          {card.matches.length ? <ul className="op-chat-matches">{card.matches.map((m) => (
            <li key={m.creator_id}>
              <div><b>{m.name}</b>{m.handles.map((h) => <span key={h.platform} className="op-chat-proven"><Check size={11} />{h.platform} @{h.handle}</span>)}</div>
              <p>{m.reason}</p>
              <div className="op-chat-meta"><i style={{ width: `${m.fit}%` }} /><span>fit {m.fit}</span>{m.paid_deliveries ? <span>{m.paid_deliveries} paid deliveries</span> : <span>no paid deliveries yet</span>}{m.samples.slice(0, 2).map((s) => <a key={s} href={s} target="_blank" rel="noreferrer">sample <ArrowUpRight size={11} /></a>)}</div>
            </li>
          ))}</ul> : <p className="op-chat-empty">No proven creator fits this task yet. Once the budget is open, it is listed for anyone to apply.</p>}
        </div>
      );
    case "fund": {
      const q = card.quote;
      return (
        <div className="op-chat-card">
          <header><span className="eyebrow">FUND {usd(q.musd)} OF MUSD FROM BTC · BTC AT {usd(q.btc_usd)}</span><strong>Two ways, read live from Mezo</strong></header>
          <div className="op-chat-fund">
            <div><b>Borrow against BTC</b><p>Keep the BTC as collateral and borrow {q.borrow.debt_musd.toLocaleString("en-US", { maximumFractionDigits: 2 })} MUSD. At a {q.borrow.target_ratio * 100}% ratio that takes {btc(q.borrow.collateral_btc)}; liquidation is at {Math.round(q.borrow.liquidation_ratio * 100)}%. Fee {usd(q.borrow.fee_musd)}, plus a {usd(q.borrow.gas_deposit_musd)} deposit returned when the loan closes.</p>{q.borrow.note && <small>{q.borrow.note}</small>}
              <a className="btn btn-ghost btn-sm" href="https://testnet.mezo.org/feature/borrow" target="_blank" rel="noreferrer">Borrow in the Mezo app <ArrowUpRight size={13} /></a></div>
            {q.swap && <div><b>Swap BTC for MUSD</b><p>About {btc(q.swap.btc_in)} buys {q.swap.musd_out.toLocaleString("en-US", { maximumFractionDigits: 2 })} MUSD through Mezo&rsquo;s pools. Simpler for a small budget; the BTC is sold.</p>
              <a className="btn btn-ghost btn-sm" href="https://testnet.mezo.org" target="_blank" rel="noreferrer">Swap in the Mezo app <ArrowUpRight size={13} /></a></div>}
          </div>
        </div>
      );
    }
    case "profile":
      return (
        <div className="op-chat-card">
          <header><span className="eyebrow">YOUR PROFILE</span><strong>{card.profile.name}</strong></header>
          <p className="op-chat-brief">{[card.profile.kinds.map(kindLabel).join(", "), card.profile.niches.join(", "), card.profile.rate_min_usd !== null ? `${usd(card.profile.rate_min_usd)}–${usd(card.profile.rate_max_usd ?? 0)}` : null, card.profile.networks.join(", ")].filter(Boolean).join(" · ")}</p>
          <ul className="op-chat-handles">{card.handles.map((h) => (
            <li key={h.platform}>{h.proven ? <span className="op-chat-proven"><Check size={11} />proven</span> : <span className="op-chat-code">{h.code}</span>}<b>{h.platform} @{h.handle}</b>{!h.proven && <small>{h.platform === "x" ? "Post the code on X from this account, then paste the link here." : h.platform === "youtube" ? "Put the code in a video's title on this channel, then paste the link." : "Make a public gist with the code, then paste its link."}</small>}</li>
          ))}</ul>
        </div>
      );
    case "proof":
      return <div className={`op-chat-card op-chat-line ${card.proven ? "ok" : "no"}`}>{card.proven ? <Check size={15} /> : <X size={15} />}{card.proven ? `@${card.handle} on ${card.platform} is proven.` : `Not proven: ${card.error}`}</div>;
    case "task_matches":
      return (
        <div className="op-chat-card">
          <header><span className="eyebrow">PAID TASKS THAT FIT</span><strong>{card.matches.length} {card.matches.length === 1 ? "task" : "tasks"}</strong></header>
          <ul className="op-chat-matches">{card.matches.map((t) => (
            <li key={t.task_id}>
              <div><b>{t.title}</b><span className="op-kind">{kindLabel(t.kind)}</span><span>{t.project}</span></div>
              <p>{t.reason}</p>
              <div className="op-chat-meta"><i style={{ width: `${t.fit}%` }} /><span>{usd(t.rate_usd[0])}–{usd(t.rate_usd[1])} {t.token}</span>
                <a href={opHref(`/p/${t.project_id}`)}>project</a>
                <button className="btn btn-ghost btn-sm" onClick={() => say(`Apply me to "${t.title}" (${t.task_id}).`)}>Apply</button></div>
            </li>
          ))}</ul>
        </div>
      );
    case "application":
      return <div className="op-chat-card op-chat-line ok"><Check size={15} />Applied to {card.task} as @{card.handle}. <a href={opHref(`/me/${card.application_token}`)}>Your application, offer and payment <ArrowUpRight size={12} /></a></div>;
    case "status":
      return (
        <div className="op-chat-card">
          <header><span className="eyebrow">WHERE THINGS ARE</span><strong>{card.paid_deliveries} paid · {usd(card.paid_usd)}</strong></header>
          {card.invites?.some((i) => i.status === "invited") && <ul className="op-chat-tasks">{card.invites.filter((i) => i.status === "invited").map((i) => (
            <li key={i.task}><span className="op-chat-proven">invited</span><b>{i.task}</b><button className="btn btn-gold btn-sm" onClick={() => say(`Apply me to ${i.task}, the task I was invited to.`)}>Apply</button>{i.note && <small>{i.note}</small>}</li>
          ))}</ul>}
          <ul className="op-chat-tasks">{card.applications.map((a) => <li key={a.application_token}><b>{a.task}</b><span>{a.status}</span><a href={opHref(`/me/${a.application_token}`)}>open <ArrowUpRight size={11} /></a></li>)}</ul>
        </div>
      );
    default:
      return null;
  }
}

export function OpChat() {
  const [role, setRole] = useState<ChatRole>(() => (read("quaestor-operator-chat-role") === "creator" ? "creator" : "business"));
  const [log, setLog] = useState<Entry[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const end = useRef<HTMLDivElement | null>(null);

  // Pick the conversation back up for this role, if this tab has one.
  useEffect(() => {
    write("quaestor-operator-chat-role", role);
    setLog([]); setErr(null);
    const token = read(SESSION_KEY(role));
    if (!token) return;
    fetchChat(token).then((t) => setLog(t.log)).catch(() => write(SESSION_KEY(role), null));
  }, [role]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [log.length, busy]);
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const say = async (message: string) => {
    const m = message.trim();
    if (!m || busy) return;
    setErr(null); setText(""); setBusy(true);
    setLog((l) => [...l, { role: "user", text: m, cards: [], at: new Date().toISOString() }]);
    try {
      const out = await sendChat({ message: m, role, session: read(SESSION_KEY(role)) ?? undefined, creator_token: read(CREATOR_KEY) ?? undefined });
      write(SESSION_KEY(role), out.token);
      if (out.creator_token) write(CREATOR_KEY, out.creator_token);
      setLog((l) => [...l, { role: "assistant", text: out.reply, cards: out.cards, at: new Date().toISOString() }]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restart = () => { write(SESSION_KEY(role), null); setLog([]); setErr(null); };

  return <>
    <section className="page-intro compact"><div>
      <a className="back-link" href={opHref("")}><ArrowLeft size={13} />Quaestor Operator</a>
      <span className="eyebrow">TALK TO THE OPERATOR · MUSD ON MEZO, USDC ON ARC</span>
      <h1>{role === "business" ? "Say what you want promoted" : "Find paid work that fits you"}</h1>
      <p>{role === "business"
        ? "The Operator drafts the project, finds proven creators who fit each task, and quotes how to fund it from your BTC. Nothing moves until your wallet signs the budget."
        : "Tell the Operator what you make and where you are paid. Prove your handles once, and it shows you the paid tasks that fit. You are paid only for delivered work it has checked."}</p>
    </div></section>

    <section className="op-chat">
      <div className="op-chat-roles" role="tablist" aria-label="Who you are">
        {(["business", "creator"] as ChatRole[]).map((r) => <button key={r} role="tab" aria-selected={role === r} className={role === r ? "selected" : ""} onClick={() => setRole(r)}>{r === "business" ? "I'm a business" : "I'm a creator"}</button>)}
        {log.length > 0 && <button className="op-chat-restart" onClick={restart}>New conversation</button>}
      </div>

      <div className="op-chat-log" aria-live="polite">
        {!log.length && <div className="op-chat-starters">{STARTERS[role].map((s) => <button key={s} onClick={() => void say(s)}>{s}</button>)}</div>}
        {log.map((e, i) => (
          <div key={i} className={`op-chat-msg ${e.role}`}>
            {e.text && <div className="op-chat-bubble">{e.role === "assistant" ? <Prose text={e.text} /> : e.text}</div>}
            {e.cards.map((c, j) => <Card key={j} card={c} say={(m) => void say(m)} />)}
          </div>
        ))}
        {busy && <div className="op-chat-msg assistant"><div className="op-chat-bubble op-chat-thinking">The Operator is working{elapsed > 4 ? ` · ${elapsed} s` : ""}<span>…</span></div></div>}
        {err && <div className="op-chat-err">{err}</div>}
        <div ref={end} />
      </div>

      <form className="op-chat-input" onSubmit={(e) => { e.preventDefault(); void say(text); }}>
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void say(text); } }}
          placeholder={role === "business" ? "What do you want promoted, to whom, and roughly how much in MUSD?" : "What you make, your handles, the wallet you are paid at…"} aria-label="Message" maxLength={4000} />
        <button className="btn btn-gold" disabled={busy || !text.trim()} aria-label="Send"><Send size={16} /></button>
      </form>
    </section>
  </>;
}
