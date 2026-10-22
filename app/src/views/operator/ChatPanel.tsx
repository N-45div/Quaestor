import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, ArrowUpRight, Check, Copy, Send, X } from "lucide-react";
import { formatEther, parseEther } from "viem";
import { chainRow, fetchChat, fetchProject, kindLabel, sendChat, type ChatApplication, type ChatCard, type ChatDraft, type ChatRole, type ChatTranscript } from "../../lib/operator";
import { chainOf, explainWalletError, readClient } from "../../lib/evm/stocks";
import { balances, borrowMore, openTrove, swapBtcForMusd, troveOf } from "../../lib/mezo";
import { useOpMaybe } from "./OperatorPages";
import { ConnectWallet } from "./parts";
import "./operator.css";

/**
 * The conversation with the Operator, wherever it is shown: the explorer's chat page ("page") or the outreach page's
 * hero ("hero"). A business says what it wants promoted and gets a drafted project, matched creators, a live quote for
 * funding it from BTC on Mezo, and then the campaign itself: the address it names owns it, and it funds it by sending to
 * the campaign's contract. A creator builds a profile, proves their handles, applies, answers offers and sends the
 * delivered link, all here. The conversation lives on the hub; this browser remembers which one is yours.
 */
export type Entry = ChatTranscript["log"][number];

const SESSION_KEY = (role: ChatRole) => `quaestor-operator-chat:${role}`;
const CREATOR_KEY = "quaestor-operator-creator";
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private window */ } };

export const EXAMPLES: Record<ChatRole, string[]> = {
  business: [
    "I run a Bitcoin savings app on Mezo and want a few X posts explaining how to borrow MUSD against BTC with it, about 100 MUSD in all.",
    "We need a YouTube walkthrough and two threads about our Mezo wallet, budget around 300 MUSD.",
  ],
  creator: [
    "I write X threads about Bitcoin DeFi. Pay me in MUSD on Mezo, usually $20 to $50 a thread.",
    "I make short YouTube tutorials on DeFi apps. What can I apply to?",
  ],
};

/** The model writes **bold** and `code` (an address, a code) now and then; show them so, as text nodes only, never as HTML. */
export function Prose({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*|`[^`\n]+`)/g).map((part, i) => (
    /^\*\*[^*]+\*\*$/.test(part) ? <b key={i}>{part.slice(2, -2)}</b>
      : /^`[^`\n]+`$/.test(part) ? <code key={i} className="op-chat-inline">{part.slice(1, -1)}</code>
        : <span key={i}>{part}</span>))}</>;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const btc = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 5 })} BTC`;

type Quote = Extract<ChatCard, { type: "fund" }>["quote"];

/** Funding from the owner's wallet needs the hub's networks and the browser's wallets; until they are known, nothing. */
function FundHere({ quote }: { quote: Quote }) {
  const op = useOpMaybe();
  return op ? <FundFromWallet quote={quote} op={op} /> : null;
}

/**
 * Fund the budget here, from the owner's wallet on Mezo: swap BTC for MUSD, open a trove against BTC, or borrow more
 * on a trove already open. Each is a transaction the wallet signs; the page only builds it.
 */
function FundFromWallet({ quote, op }: { quote: Quote; op: NonNullable<ReturnType<typeof useOpMaybe>> }) {
  const { wallet, networkOf } = op;
  const net = networkOf("mezo-testnet");
  const [state, setState] = useState<{ busy?: string; tx?: { label: string; hash: string }; err?: string }>({});
  const [mine, setMine] = useState<{ btc: bigint; musd: bigint; trove: { active: boolean; coll: bigint; debt: bigint } } | null>(null);
  const onMezo = !!wallet && !!net && wallet.network === net.key;

  const refresh = async () => {
    if (!onMezo || !net || !wallet) return;
    const reader = readClient(chainRow(net));
    const [b, t] = await Promise.all([balances(reader, wallet.account), troveOf(reader, wallet.account)]);
    setMine({ ...b, trove: t });
  };
  useEffect(() => { void refresh().catch(() => undefined); }, [onMezo, wallet?.account]);

  if (!net) return null;
  if (!onMezo || !wallet) {
    return <div className="op-chat-fund-here"><span>Fund it here, from your wallet on Mezo:</span><ConnectWallet network={net} onError={(m) => setState({ err: m })} label="Connect a wallet on Mezo" />{state.err && <span className="form-msg err">{state.err}</span>}</div>;
  }
  const signer = { wallet: wallet.client, account: wallet.account, chain: chainOf(chainRow(net)), reader: readClient(chainRow(net)) };
  const run = async (label: string, fn: (step: (l: string) => void) => Promise<string>) => {
    setState({ busy: label });
    try {
      const hash = await fn((l) => setState({ busy: l }));
      setState({ tx: { label, hash } });
      await refresh();
    } catch (e) {
      setState({ err: explainWalletError(e) });
    }
  };
  const swap = quote.swap;
  // Say what the wallet lacks before asking it to sign something Mezo would revert.
  const short = (need: number) => (mine && mine.btc < parseEther(need.toFixed(10)) ? `needs ${btc(need)}; your wallet holds ${Number(formatEther(mine.btc)).toFixed(5)} BTC` : null);
  const swapShort = swap ? short(swap.btc_in + 0.0001) : null;
  const borrowShort = mine?.trove.active ? null : short(quote.borrow.collateral_btc + 0.0001);
  const borrowLabel = mine?.trove.active ? `Borrow ${quote.musd.toLocaleString("en-US")} more MUSD on your trove` : `Lock ${btc(quote.borrow.collateral_btc)} and borrow ${quote.borrow.debt_musd.toLocaleString("en-US", { maximumFractionDigits: 0 })} MUSD`;
  return (
    <div className="op-chat-fund-here">
      {mine && <span>Your wallet: {Number(formatEther(mine.btc)).toFixed(5)} BTC · {Number(formatEther(mine.musd)).toLocaleString("en-US", { maximumFractionDigits: 2 })} MUSD{mine.trove.active ? ` · a trove of ${Number(formatEther(mine.trove.coll)).toFixed(4)} BTC` : ""}</span>}
      <div className="form-actions">
        {swap && <button className="btn btn-gold btn-sm" disabled={!!state.busy || !!swapShort} title={swapShort ?? undefined} onClick={() => void run("swap", (step) => swapBtcForMusd(signer as never, parseEther(swap.btc_in.toFixed(10)), parseEther((swap.musd_out * 0.99).toFixed(6)), step))}>Swap {btc(swap.btc_in)} for MUSD</button>}
        <button className="btn btn-ghost btn-sm" disabled={!!state.busy || !!borrowShort} title={borrowShort ?? undefined} onClick={() => void run("borrow", (step) => (mine?.trove.active
          ? borrowMore(signer as never, parseEther(quote.musd.toFixed(6)), step)
          : openTrove(signer as never, parseEther(quote.borrow.debt_musd.toFixed(6)), parseEther(quote.borrow.collateral_btc.toFixed(10)), step)))}>{borrowLabel}</button>
      </div>
      {(swapShort || borrowShort) && <span className="form-msg">{swapShort ? `The swap ${swapShort}. ` : ""}{borrowShort ? `Borrowing ${borrowShort}. ` : ""}Testnet BTC comes from <a href="https://faucet.test.mezo.org" target="_blank" rel="noreferrer">Mezo&rsquo;s faucet <ArrowUpRight size={11} /></a></span>}
      {state.busy && <span className="form-msg">{state.busy === "swap" || state.busy === "borrow" ? "Waiting for your wallet…" : state.busy}</span>}
      {state.tx && <span className="form-msg ok"><Check size={13} />{state.tx.label === "swap" ? "Swapped" : "Borrowed"} on Mezo. <a href={`${net.explorer}/tx/${state.tx.hash}`} target="_blank" rel="noreferrer">See the transaction <ArrowUpRight size={11} /></a> Now send the MUSD to the campaign&rsquo;s address.</span>}
      {state.err && <span className="form-msg err">{state.err}</span>}
    </div>
  );
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The draft becomes a campaign from here without connecting a wallet: the business names the address that will own it,
 * and the Operator's agent opens the contract. The address is said in the chat, so the model and the record see it.
 */
function OpenCampaign({ draft, say }: { draft: ChatDraft; say: (m: string) => void }) {
  const [owner, setOwner] = useState("");
  const ok = /^0x[0-9a-fA-F]{40}$/.test(owner.trim());
  return (
    <form className="op-chat-open" onSubmit={(e) => { e.preventDefault(); if (ok) say(`Open the campaign. The owner address is ${owner.trim()}.`); }}>
      <span>Name the address that will own it: only that address can withdraw, pause or change the limits. Nothing to connect; the Operator opens the contract and you fund it by sending {draft.token} to it.</span>
      <div className="op-chat-open-row">
        <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="0x… the owner's address" aria-label="Owner address" spellCheck={false} autoComplete="off" />
        <button className="btn btn-gold btn-sm" disabled={!ok}>Open the campaign</button>
      </div>
    </form>
  );
}

/**
 * A campaign the agent opened: where to send the budget, what has arrived (read from the hub while it waits), who owns
 * it and what the agent's key may do with it.
 */
function CampaignCard({ card, live }: { card: Extract<ChatCard, { type: "campaign" }>; live: boolean }) {
  const c = card.campaign;
  const [arrived, setArrived] = useState<number | null>(card.arrived_usd);
  const [funded, setFunded] = useState(c.funded);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!live || funded) return;
    let on = true;
    // The project's public page lists only open tasks, and a chat-opened campaign has none until it is funded.
    const check = () => fetchProject(c.project_id).then((p) => {
      if (!on) return;
      if (p.budget) setArrived(p.budget.free_usd + p.budget.escrowed_usd);
      if (p.tasks.length) setFunded(true);
    }).catch(() => undefined);
    void check();
    const t = setInterval(check, 10_000);
    return () => { on = false; clearInterval(t); };
  }, [live, funded, c.project_id]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(c.governor); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* the address is on screen to copy by hand */ }
  };
  const pct = arrived === null ? 0 : Math.min(100, (arrived / c.limits.budget_usd) * 100);
  return (
    <div className="op-chat-card op-chat-campaign">
      <header><span className="eyebrow">CAMPAIGN · {c.network_name.toUpperCase()} · {c.token}</span><strong>{c.name}</strong></header>
      <div className="op-chat-deposit">
        <span>Send {c.token} on {c.network_name} to</span>
        <code>{c.governor}</code>
        {live && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>{copied ? <><Check size={13} />Copied</> : <><Copy size={13} />Copy</>}</button>}
      </div>
      <div className="op-chat-progress" aria-hidden><i style={{ width: `${pct}%` }} /></div>
      <p className={`op-chat-funding${funded ? " ok" : ""}`}>{funded
        ? <><Check size={14} />{usd(arrived ?? 0)} {c.token} arrived. Its tasks are open to creators; the Operator screens whoever applies.</>
        : arrived
          ? `${usd(arrived)} of ${usd(c.limits.budget_usd)} has arrived. The tasks open once it holds what the dearest task pays.`
          : `Waiting for up to ${usd(c.limits.budget_usd)} in ${c.token}, from any wallet or exchange.${live ? " This updates on its own." : ""}`}</p>
      <ul className="op-chat-facts">
        <li><b>Owner</b><span>{shortAddr(c.owner)}: the only address that can withdraw, pause or change the limits.</span></li>
        <li><b>The agent</b><span>{shortAddr(c.operator)}, {c.custody}: it can only escrow and pay creators, up to {usd(c.limits.per_deal_usd)} a deal and {usd(c.limits.per_week_usd)} a week.</span></li>
      </ul>
      <footer><a href={c.governor_url} target="_blank" rel="noreferrer">The contract <ArrowUpRight size={11} /></a>{c.tx_url && <a href={c.tx_url} target="_blank" rel="noreferrer">Opened in this transaction <ArrowUpRight size={11} /></a>}</footer>
    </div>
  );
}

/** What an application stands at, in words a creator reads at a glance. */
function standing(a: ChatApplication): string {
  if (a.deal === "offered") return `offered ${usd(a.pay_usd ?? 0)}`;
  if (a.deal === "open") return `deal open · ${usd(a.pay_usd ?? 0)} escrowed`;
  if (a.deal === "pending_owner") return "accepted · waiting for the business";
  if (a.deal) return a.deal.replace(/_/g, " ");
  return a.status;
}

/**
 * One card under a reply. `live` is false for a recorded conversation replayed on a page: its buttons do nothing.
 * `prefill` puts words in the message box for the person to finish, such as the link to their delivery.
 */
export function ChatCardView({ card, say, live = true, prefill, campaignOpen = false }: { card: ChatCard; say: (m: string) => void; live?: boolean; prefill?: (m: string) => void; campaignOpen?: boolean }) {
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
          <footer><span>Budget {usd(card.total_min_usd)}–{usd(card.total_max_usd)} in {d.token}</span></footer>
          {live && !campaignOpen && <OpenCampaign draft={d} say={say} />}
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
            <div><b>Borrow against BTC</b><p>Keep the BTC as collateral and borrow {q.borrow.debt_musd.toLocaleString("en-US", { maximumFractionDigits: 2 })} MUSD. At a {q.borrow.target_ratio * 100}% ratio that takes {btc(q.borrow.collateral_btc)}; liquidation is at {Math.round(q.borrow.liquidation_ratio * 100)}%. Fee {usd(q.borrow.fee_musd)}, plus a {usd(q.borrow.gas_deposit_musd)} deposit returned when the loan closes.</p>{q.borrow.note && <small>{q.borrow.note}</small>}</div>
            {q.swap && <div><b>Swap BTC for MUSD</b><p>About {btc(q.swap.btc_in)} buys {q.swap.musd_out.toLocaleString("en-US", { maximumFractionDigits: 2 })} MUSD through Mezo&rsquo;s pools. Simpler for a small budget; the BTC is sold.</p></div>}
          </div>
          {live && <FundHere quote={q} />}
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
                {live && <button className="btn btn-ghost btn-sm" onClick={() => say(`Apply me to "${t.title}" (${t.task_id}).`)}>Apply</button>}</div>
            </li>
          ))}</ul>
        </div>
      );
    case "application":
      return <div className="op-chat-card op-chat-line ok"><Check size={15} />Applied to {card.task} as @{card.handle}. The Operator screens it within minutes; ask here how it went.</div>;
    case "status":
      return (
        <div className="op-chat-card">
          <header><span className="eyebrow">WHERE THINGS ARE</span><strong>{card.paid_deliveries} paid · {usd(card.paid_usd)}</strong></header>
          {card.invites?.some((i) => i.status === "invited") && <ul className="op-chat-tasks">{card.invites.filter((i) => i.status === "invited").map((i) => (
            <li key={i.task}><span className="op-chat-proven">invited</span><b>{i.task}</b>{live && <button className="btn btn-gold btn-sm" onClick={() => say(`Apply me to ${i.task}, the task I was invited to.`)}>Apply</button>}{i.note && <small>{i.note}</small>}</li>
          ))}</ul>}
          <ul className="op-chat-tasks">{card.applications.map((a) => (
            <li key={a.application_token}>
              <b>{a.task}</b><span>{standing(a)}</span>
              {a.claim_code && <span className="op-chat-code" title="Put this code in the work you publish">{a.claim_code}</span>}
              {live && a.deal === "offered" && <span className="op-chat-acts">
                <button className="btn btn-gold btn-sm" onClick={() => say(`Accept the offer on ${a.task}.`)}>Accept</button>
                <button className="btn btn-ghost btn-sm" onClick={() => say(`Decline the offer on ${a.task}.`)}>Decline</button>
              </span>}
              {live && a.deal === "open" && prefill && <button className="btn btn-ghost btn-sm" onClick={() => prefill(`Here is the link to my delivery for ${a.task}: `)}>Send the link</button>}
              {a.deliveries?.map((d) => <small key={d.url}>{d.status === "paid" ? `Paid ${usd(d.paid_usd ?? 0)}` : d.status.replace(/_/g, " ")} · <a href={d.url} target="_blank" rel="noreferrer">the work <ArrowUpRight size={11} /></a></small>)}
            </li>
          ))}</ul>
        </div>
      );
    case "campaign":
      return <CampaignCard card={card} live={live} />;
    case "deal":
      return <div className={`op-chat-card op-chat-line ${card.status === "error" ? "no" : "ok"}`}>{card.status === "error" ? <X size={15} /> : <Check size={15} />}{
        card.status === "deal_open" ? `Accepted: ${card.detail} in the campaign's contract. Publish the work with the deal's code, then send me the link.`
          : card.status === "deal_pending" ? "Accepted. The amount is over what the Operator agrees alone, so the business approves it first."
            : card.status === "lapsed" ? "Declined. Nothing was escrowed." : card.detail}</div>;
    case "delivery":
      return <div className="op-chat-card op-chat-line ok"><Check size={15} />Sent <a href={card.url} target="_blank" rel="noreferrer">the work <ArrowUpRight size={11} /></a> for {card.task_id}. It is checked in code, then judged; ask here how it went.</div>;
    default:
      return null;
  }
}

/** An example typed out letter by letter, then the next, while the box is empty and nobody is typing. */
function useTypedExample(examples: string[], active: boolean): string {
  const [shown, setShown] = useState("");
  useEffect(() => {
    if (!active) { setShown(""); return; }
    let which = 0, at = 0, pause = 0;
    const t = setInterval(() => {
      const full = examples[which % examples.length];
      if (pause > 0) { pause--; return; }
      if (at < full.length) { at++; setShown(full.slice(0, at)); return; }
      pause = 40; at = 0; which++;
    }, 32);
    return () => clearInterval(t);
  }, [active, examples]);
  return shown;
}

export interface Chip { label: string; icon?: ReactNode; role: ChatRole; message?: string }

/**
 * `chips` start a conversation; `suggestions` are what the hub is paying for right now, offered the same way, so a
 * creator finds the open campaigns without leaving the chat.
 */
export function ChatPanel({ variant, role, onRole, chips = [], suggestions = [] }: { variant: "page" | "hero"; role: ChatRole; onRole: (r: ChatRole) => void; chips?: Chip[]; suggestions?: Chip[] }) {
  const [log, setLog] = useState<Entry[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const end = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);
  // A chip for the other role switches roles first; its message goes once that role's conversation has loaded.
  const pending = useRef<string | null>(null);
  const typed = useTypedExample(EXAMPLES[role], variant === "hero" && !text && !focused && !log.length);

  // Pick the conversation back up for this role, if this browser has one.
  useEffect(() => {
    write("quaestor-operator-chat-role", role);
    setLog([]); setErr(null);
    const go = () => { const m = pending.current; pending.current = null; if (m) void say(m, role); };
    const token = read(SESSION_KEY(role));
    if (!token) { go(); return; }
    fetchChat(token).then((t) => setLog(t.log)).catch(() => write(SESSION_KEY(role), null)).finally(go);
  }, [role]);
  useEffect(() => { if (log.length) end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [log.length, busy]);
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const say = async (message: string, as: ChatRole = role) => {
    const m = message.trim();
    if (!m || busy) return;
    setErr(null); setText(""); setBusy(true);
    setLog((l) => [...l, { role: "user", text: m, cards: [], at: new Date().toISOString() }]);
    try {
      const out = await sendChat({ message: m, role: as, session: read(SESSION_KEY(as)) ?? undefined, creator_token: read(CREATOR_KEY) ?? undefined });
      write(SESSION_KEY(as), out.token);
      if (out.creator_token) write(CREATOR_KEY, out.creator_token);
      setLog((l) => [...l, { role: "assistant", text: out.reply, cards: out.cards, at: new Date().toISOString() }]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restart = () => { write(SESSION_KEY(role), null); setLog([]); setErr(null); };
  const chip = (c: Chip) => {
    if (c.role !== role) {
      pending.current = c.message ?? null;
      onRole(c.role);
      if (!c.message) box.current?.focus();
    } else if (c.message) void say(c.message, c.role);
    else box.current?.focus();
  };
  const prefill = (m: string) => { setText(m); box.current?.focus(); };
  const campaignOpen = log.some((e) => e.cards.some((c) => c.type === "campaign"));

  const thread = (
    <div className="op-chat-log" aria-live="polite">
      {variant === "page" && !log.length && <div className="op-chat-starters">{EXAMPLES[role].map((s) => <button key={s} onClick={() => void say(s)}>{s}</button>)}</div>}
      {log.map((e, i) => (
        <div key={i} className={`op-chat-msg ${e.role}`}>
          {e.text && <div className="op-chat-bubble">{e.role === "assistant" ? <Prose text={e.text} /> : e.text}</div>}
          {e.cards.map((c, j) => <ChatCardView key={j} card={c} say={(m) => void say(m)} prefill={prefill} campaignOpen={campaignOpen} />)}
        </div>
      ))}
      {busy && <div className="op-chat-msg assistant"><div className="op-chat-bubble op-chat-thinking">The Operator is working{elapsed > 4 ? ` · ${elapsed} s` : ""}{elapsed > 25 ? " · a transaction on the chain can take a minute or two" : ""}<span>…</span></div></div>}
      {err && <div className="op-chat-err">{err}</div>}
      <div ref={end} />
    </div>
  );
  const roles = (
    <div className="op-chat-roles" role="tablist" aria-label="Who you are">
      {(["business", "creator"] as ChatRole[]).map((r) => <button key={r} type="button" role="tab" aria-selected={role === r} className={role === r ? "selected" : ""} onClick={() => onRole(r)}>{r === "business" ? "I'm a business" : "I'm a creator"}</button>)}
      {log.length > 0 && <button type="button" className="op-chat-restart" onClick={restart}>New conversation</button>}
    </div>
  );
  const placeholder = role === "business" ? "What do you want promoted, to whom, and roughly how much in MUSD?" : "What you make, your handles, the wallet you are paid at…";
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void say(text); } };

  if (variant === "page") {
    return (
      <section className="op-chat">
        {roles}
        {thread}
        <form className="op-chat-input" onSubmit={(e) => { e.preventDefault(); void say(text); }}>
          <textarea ref={box} rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder={placeholder} aria-label="Message" maxLength={4000} />
          <button className="btn btn-gold" disabled={busy || !text.trim()} aria-label="Send"><Send size={16} /></button>
        </form>
      </section>
    );
  }

  return (
    <div className={`oc-chat${log.length ? " has-thread" : ""}`}>
      {log.length > 0 && <div className="oc-thread">{thread}</div>}
      <form className="oc-box" onSubmit={(e) => { e.preventDefault(); void say(text); }}>
        <textarea ref={box} rows={log.length ? 2 : 3} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} placeholder={log.length ? "Reply to the Operator…" : typed || placeholder} aria-label="Message to the Operator" maxLength={4000} />
        <div className="oc-box-foot">
          {roles}
          <button className="oc-send" disabled={busy || !text.trim()} aria-label="Send"><ArrowUp size={18} /></button>
        </div>
      </form>
      {!log.length && chips.length > 0 && <div className="oc-chips">{chips.map((c) => <button key={c.label} type="button" onClick={() => chip(c)}>{c.icon}{c.label}</button>)}</div>}
      {suggestions.length > 0 && (!log.length || role === "creator") && <div className="oc-chips oc-suggest"><span>Paying creators now</span>{suggestions.map((c) => <button key={c.label} type="button" disabled={busy} onClick={() => chip(c)}>{c.icon}{c.label}</button>)}</div>}
    </div>
  );
}
