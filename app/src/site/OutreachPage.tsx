import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, BadgeCheck, Bitcoin, FileSearch, Handshake, Lock, MessagesSquare, Search, Sparkles, UserRound, Wallet } from "lucide-react";
import { fetchIndex, type ChatCard, type ChatRole } from "../lib/operator";
import { ChatCardView, ChatPanel, Prose, type Chip } from "../views/operator/ChatPanel";
import { OpProvider } from "../views/operator/OperatorPages";
import { Chip as Mark, Faq, Reveal, SectionHead, SiteFooter, SiteHeader, brand } from "./parts";
import replay from "./replay.json";

/**
 * Quaestor Operator's own page, at quaestor.dev/outreach: the conversation is the page. A business says what it wants
 * promoted and the Operator answers in place, with the draft, the creators who fit, a live quote for funding it from
 * BTC and then the campaign's own address to fund; a creator signs up, applies and delivers the same way, with the
 * campaigns paying now offered as suggestions in the chat. Below it, a real conversation replayed, and how the
 * Operator is held to its word, with the transactions that show it.
 */
const CHIPS: Chip[] = [
  { label: "Find creators for my app", icon: <Search size={15} />, role: "business", message: "I want creators to promote my app on X. Ask me what you need to know." },
  { label: "Fund a campaign from BTC", icon: <Bitcoin size={15} />, role: "business", message: "How would I fund a 100 MUSD campaign from my BTC on Mezo?" },
  { label: "I'm a creator", icon: <UserRound size={15} />, role: "creator" },
  { label: "Show me paid work", icon: <Sparkles size={15} />, role: "creator", message: "What paid work can I apply to right now?" },
];

const STEPS = [
  { icon: <MessagesSquare size={20} />, title: "Draft", text: "Say what you want promoted and to whom. The Operator writes the brief and up to four tasks, each with a rate band inside the budget you named." },
  { icon: <Search size={20} />, title: "Match", text: "Creators who have proven their handles and fit the task in code, ranked by the model with a reason each. You invite; they apply." },
  { icon: <Lock size={20} />, title: "Open", text: "Name the address that will own the campaign. The Operator's agent opens its payout contract; nothing to connect, and only your address can withdraw or pause." },
  { icon: <Bitcoin size={20} />, title: "Fund", text: "Send MUSD to the campaign's address from any wallet or exchange, or borrow it against your BTC first. The tasks open to creators when it arrives." },
  { icon: <FileSearch size={20} />, title: "Check", text: "The delivered link must be the creator's, published after the deal, carry the deal's code and say #ad up front, checked in code first." },
  { icon: <Handshake size={20} />, title: "Pay", text: "The model judges the work against the brief, and the governor pays the creator in MUSD, with the hash of the reasoning on-chain." },
];

const PROOF = [
  { what: "An honest application, offered $0.30", how: "Kimi read the pitch and the samples against the brief", tx: null },
  { what: "A pitch that told it to ignore its rules", how: "Turned down, and the owner's band held", tx: null },
  { what: "0.30 MUSD escrowed for the deal", how: "When the creator accepted the offer", tx: "0x4cd1ca7c807750e0a0e88f6a285b59b50ad6f2d935b0732942cb1e047411a5c4" },
  { what: "An article without #ad up front", how: "Refused in code, before any model read it; nothing sent", tx: null },
  { what: "The disclosed article, paid 0.30 MUSD", how: "Judged against the brief; its record re-hashes to the hash on-chain", tx: "0x771f15885c9e54aa79b80e037bd95aa5478df86a26856d32760bdf94d31817cc" },
];

const FAQ = [
  { q: "Who are the creators?", a: "People who signed up themselves and proved each handle by publishing a one-time code from it. Nobody is listed who did not join, and nobody is messaged: an invitation waits in the creator's profile until they apply." },
  { q: "How is the work checked?", a: "In code first: the link is the creator's own, published after the deal opened, carries the deal's code, a pull request is merged, and a post, article or video says #ad in its opening. Only then does a model judge whether it does what the brief asked." },
  { q: "What is MUSD, and why borrow it?", a: "MUSD is Mezo's dollar, minted against Bitcoin. Borrowing it keeps your BTC as collateral rather than selling it; a loan starts at 1,800 MUSD, so a smaller budget is usually funded by swapping a little BTC instead." },
  { q: "Do I connect a wallet?", a: "No. You name the address that will own the campaign, the Operator's agent opens its payout contract, and you send the budget to that contract from wherever you hold it. A plain transfer funds it." },
  { q: "Can the Operator spend more than I set?", a: "No. The budget sits in a payout contract that your address owns. The agent's key, a Dynamic MPC wallet whose signature takes two shares, can only escrow and pay creators inside the caps per deal and per week; it cannot withdraw. Your address alone can take the money back, pause it or change the caps." },
  { q: "What does it cost?", a: "Nothing on testnet today. Payments go to the people who deliver, and the agent pays the gas for opening the campaign and for each payment." },
];

const TX = (hash: string) => `https://explorer.test.mezo.org/tx/${hash}`;

/**
 * What the hub is paying creators for now, read live, as suggestions in the chat: one tap asks the Operator about that
 * campaign as a creator. Campaigns still waiting for their budget, and the production-test budgets, are left out.
 */
function usePayingNow(): Chip[] {
  const [chips, setChips] = useState<Chip[]>([]);
  useEffect(() => {
    let live = true;
    fetchIndex().then((i) => {
      if (!live) return;
      const paying = i.projects.filter((p) => p.governor && !p.id.startsWith("operator-e2e") && (p.open_tasks ?? 1) > 0).slice(0, 4);
      setChips(paying.map((p) => ({
        label: p.name,
        icon: <img src={brand(p.network.startsWith("mezo") ? "musd.svg" : "usdc.svg")} alt="" width={16} height={16} />,
        role: "creator" as const,
        message: `What does ${p.name} pay creators for right now, and would I fit?`,
      })));
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return chips;
}

type Logged = { role: string; text: string; cards: unknown[] };

/**
 * One recorded conversation at a time, in one frame: what was said across the top, and the cards it produced side by
 * side below it, so neither side of the page runs long while the other sits empty.
 */
function Replay({ sides }: { sides: { key: string; label: string; scene: "mezo" | "arc"; log: Logged[] }[] }) {
  const [at, setAt] = useState(sides[0].key);
  const side = sides.find((s) => s.key === at) ?? sides[0];
  const said = side.log.filter((e) => e.text);
  const cards = side.log.flatMap((e) => e.cards as ChatCard[]);
  return (
    <div className="oc-replay-wrap">
      <div className="oc-replay-tabs" role="tablist" aria-label="Whose conversation">
        {sides.map((s) => <button key={s.key} type="button" role="tab" aria-selected={s.key === at} className={s.key === at ? "selected" : ""} onClick={() => setAt(s.key)}>{s.label}</button>)}
      </div>
      <div className="s-scene oc-replay" data-scene={side.scene}>
        <div className="s-glass oc-replay-glass">
          <div className="oc-replay-said">
            {said.map((e, i) => <div key={i} className={`op-chat-msg ${e.role}`}><div className="op-chat-bubble">{e.role === "assistant" ? <Prose text={e.text} /> : e.text}</div></div>)}
          </div>
          <div className={`oc-replay-cards${cards.length === 1 ? " one" : ""}`}>
            {cards.map((c, j) => <ChatCardView key={`${side.key}-${j}`} card={c} say={() => undefined} live={false} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function OutreachPage() {
  const [role, setRole] = useState<ChatRole>(() => {
    try { return localStorage.getItem("quaestor-operator-chat-role") === "creator" ? "creator" : "business"; } catch { return "business"; }
  });
  const hero = useRef<HTMLElement | null>(null);
  const startAs = (r: ChatRole) => {
    setRole(r);
    hero.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => hero.current?.querySelector("textarea")?.focus(), 450);
  };
  const paying = usePayingNow();
  const recorded = new Date(replay.recorded_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  return (
    <div className="s oc">
      <SiteHeader page="outreach" />
      <main>
        <section className="oc-hero" data-scene="mezo" ref={hero}>
          <span className="s-news"><b><img src={brand("mezo.svg")} alt="" />Live</b>Quaestor Operator · pays in MUSD on Mezo and USDC on Arc</span>
          <h1 className="s-h1">Promotion you pay for only when it is real.</h1>
          <p className="s-lede">Tell the Operator what you want promoted. It drafts the campaign, finds creators who have proven their handles, and pays each one when the work is live, theirs and marked #ad.</p>
          <OpProvider><ChatPanel variant="hero" role={role} onRole={setRole} chips={CHIPS} suggestions={paying} /></OpProvider>
        </section>

        <div className="s-strip oc-strip">
          <div className="s-strip-row">
            <span className="oc-strip-label">Paid in</span><Mark icon={brand("musd.svg")} name="MUSD on Mezo" /><Mark icon={brand("usdc.svg")} name="USDC on Arc" />
            <span className="oc-strip-label">Checked on</span><Mark icon={brand("x.svg")} name="X" /><Mark icon={brand("youtube.svg")} name="YouTube" /><Mark icon={brand("github.svg")} name="GitHub" />
            <span className="oc-strip-label">Decided by</span><Mark icon={brand("kimi.png")} name="Kimi" />
          </div>
        </div>

        <Reveal className="s-section" id="watch">
          <SectionHead eyebrow="Ask once" title="Watch it answer." lede={<>A real conversation with the live Operator, recorded on {recorded}. The prompts are ours; every reply and card is what it answered, quotes read from Mezo at that moment.</>} center />
          <Replay sides={[
            { key: "business", label: "A business", scene: "mezo", log: replay.business.slice(0, 2) },
            { key: "creator", label: "A creator", scene: "arc", log: replay.creator.slice(0, 2) },
          ]} />
        </Reveal>

        <Reveal className="s-section" id="how">
          <SectionHead eyebrow="The whole campaign" title="One operator, from brief to payout." lede="Each step is checked in code or held by the contract your address owns. The model drafts, ranks and judges; the agent's key pays only creators, inside your caps." />
          <ol className="s-grid s-grid-3 oc-steps">{STEPS.map((s) => <li key={s.title} className="s-card"><span className="oc-step-icon">{s.icon}</span><h3 className="s-h3">{s.title}</h3><p className="s-p">{s.text}</p></li>)}</ol>
        </Reveal>

        <Reveal className="s-section">
          <div className="s-product">
            <div>
              <span className="s-eyebrow">For creators</span>
              <h2 className="s-h2" style={{ marginTop: 14 }}>Paid work, on proof.</h2>
              <p className="s-lede">Tell the Operator what you make and where you are paid. Prove each handle once, and it shows you the paid tasks that fit, with the businesses that invited you first.</p>
              <ul className="s-ticks">
                <li><BadgeCheck size={16} /><span>A profile once, not an application per project.</span></li>
                <li><BadgeCheck size={16} /><span>Paid in MUSD on Mezo or USDC on Arc, the moment your work checks out.</span></li>
                <li><BadgeCheck size={16} /><span>A track record of what you were actually paid, on-chain, that travels with you.</span></li>
              </ul>
              <div className="s-actions"><button className="s-btn s-btn-primary" onClick={() => startAs("creator")}><UserRound size={16} />I&rsquo;m a creator</button></div>
            </div>
            <div className="s-scene" data-scene="arc">
              <div className="s-glass oc-ledger">
                <h4>What the Operator did in production, on Mezo</h4>
                {PROOF.map((p) => (
                  <div key={p.what} className="oc-ledger-row">
                    <b>{p.what}</b><span>{p.how}</span>
                    {p.tx ? <a href={TX(p.tx)} target="_blank" rel="noreferrer">{p.tx.slice(0, 10)}… <ArrowUpRight size={12} /></a> : <em>no transaction</em>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal className="s-section"><Faq items={FAQ} /></Reveal>

        <section className="s-close oc-close" data-scene="ink">
          <h2 className="s-h2">Tell the Operator what you are after.</h2>
          <p className="s-lede">A campaign or a creator profile starts with one message. Only the address you name can take a budget back out.</p>
          <div className="s-actions">
            <button className="s-btn s-btn-primary" onClick={() => startAs("business")}><MessagesSquare size={16} />Start the chat</button>
            <button className="s-btn s-btn-quiet" onClick={() => startAs("creator")}><Wallet size={16} />Join as a creator</button>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
