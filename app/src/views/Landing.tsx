import { useEffect, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, Code2, Gauge, X } from "lucide-react";
import { fetchGovernor, fetchTrades, show, type GovernorView, type TradeRow } from "../lib/evm/stocks";
import { fetchProject, type OpProjectPage } from "../lib/operator";
import { BUILT_WITH, CHAINS, GITHUB, REFUSALS, brand } from "../site/chains";
import { Chip, Close, Faq, LaunchApp, ReadDocs, Reveal, SceneBox, SectionHead, SiteFooter, SiteHeader, TextLink } from "../site/parts";

const MONAD = "#/app/evm/monad-testnet";
const OPERATOR = "#/app/operator";
const HOUSE = "0xD64E22Ff0D0dc311d89Bcc5C5113F9e7f149157C"; // the house agent's governor on Monad testnet: Kimi decides, Dynamic signs
const SKILL = `${GITHUB}/tree/main/skills/quaestor-trading`;

/**
 * The house agent's allowance, read live from Monad testnet through the hub: its caps, what is left today, its
 * latest governed fill, and the refusal anyone can send it. If the free host is waking, the card says so rather
 * than showing numbers from nowhere.
 */
function LiveAllowance() {
  const [gov, setGov] = useState<GovernorView | null>(null);
  const [last, setLast] = useState<TradeRow | null>(null);
  const [waking, setWaking] = useState(false);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [g, t] = await Promise.all([fetchGovernor("monad-testnet", HOUSE), fetchTrades("monad-testnet", HOUSE)]);
        if (!live) return;
        setGov(g); setLast(t.trades[0] ?? null); setWaking(false);
      } catch {
        if (live) setWaking(true);
      }
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => { live = false; clearInterval(timer); };
  }, []);

  const unit = gov?.budgetSymbol ?? "tUSDC";
  const spent = Number(gov?.spentThisEpoch ?? 0), cap = Number(gov?.epochCap ?? 0);
  const allowed = gov?.instruments.filter((i) => i.allowed) ?? [];
  const guard = allowed.find((i) => i.guard)?.guard;

  return (
    <div className="s-glass s-live">
      <div className="s-live-bar">
        <span><i className="s-dot" />Live · Monad testnet</span>
        <a href={`${MONAD}/governors/${HOUSE}`}>governor {HOUSE.slice(0, 6)}…{HOUSE.slice(-4)} <ArrowUpRight /></a>
      </div>
      {gov ? <>
        <div className="s-live-body">
          <div className="s-live-label">The house agent&rsquo;s allowance</div>
          <div className="s-live-big"><b>{show(gov.remaining)}</b><span>{unit} left today</span></div>
          <div className="s-meter" aria-label={`${show(String(spent))} of ${show(String(cap))} ${unit} spent today`}><i style={{ width: `${cap ? Math.min(100, (100 * spent) / cap) : 0}%` }} /></div>
          <div className="s-meter-legend"><span>{show(String(spent))} spent</span><span>cap {show(String(cap))} a day</span></div>
        </div>
        <dl className="s-rules">
          <div><dt>Per trade</dt><dd>{show(gov.perTradeCap)} {unit}</dd></div>
          <div><dt>Stocks it may buy</dt><dd>{allowed.map((i) => i.symbol).join(" · ")}</dd></div>
          <div><dt>Chainlink guard</dt><dd>{guard ? `≤ ${guard.maxDeviationBps / 100}% over · ≤ ${Math.round(guard.maxStaleness / 3600)} h old` : "off"}</dd></div>
          <div><dt>Who can withdraw</dt><dd>the owner, only</dd></div>
        </dl>
        <div className="s-outcomes">
          {last ? <a className="s-outcome s-ok" href={`${MONAD}/trades/${last.tx}`}>
            <span className="s-outcome-icon"><Check /></span>
            <span><b>Settled</b> {show(last.spent)} {last.budget ?? unit} → {last.received} {last.stock} at {show(last.pricePerShare)}<small>reason committed on-chain · {last.decisionHash.slice(0, 10)}…</small></span>
            <ArrowRight />
          </a> : null}
          <a className="s-outcome s-no" href={MONAD}>
            <span className="s-outcome-icon"><X /></span>
            <span><b>Refused</b> a hijacked buy at $400,000 a token<small>PriceAboveLimit · reverted on-chain · send one yourself</small></span>
            <ArrowRight />
          </a>
        </div>
      </> : <div className="s-live-empty">{waking ? "The hosted hub is waking up; free instances sleep when idle. Give it a minute." : "Reading the governor from Monad testnet…"}</div>}
    </div>
  );
}

/** The Operator's two house budgets, read live: USDC on Arc and MUSD on Mezo. */
function LiveBudgets() {
  const [pages, setPages] = useState<Record<string, OpProjectPage | null>>({});
  const [waking, setWaking] = useState(false);
  useEffect(() => {
    let live = true;
    const ids = ["quaestor-mezo", "quaestor"];
    Promise.all(ids.map((id) => fetchProject(id).then((p) => [id, p] as const).catch(() => [id, null] as const)))
      .then((rows) => { if (!live) return; setPages(Object.fromEntries(rows)); setWaking(rows.every(([, p]) => !p)); });
    return () => { live = false; };
  }, []);
  const rows = [
    { id: "quaestor-mezo", name: "Mezo", token: "MUSD", icon: brand("musd.svg"), note: "borrowed against BTC" },
    { id: "quaestor", name: "Arc", token: "USDC", icon: brand("usdc.svg"), note: "paid out over CCTP" },
  ];
  const n = (v: number | undefined) => (v === undefined ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 2 }));
  return (
    <div className="s-glass s-budgets">
      <header><h4>The Operator&rsquo;s house budgets</h4><p>{waking ? "The hosted hub is waking up; give it a minute." : "Read live from each chain’s payout governor."}</p></header>
      {rows.map((r) => {
        const p = pages[r.id];
        return (
          <a key={r.id} className="s-budget" href={`${OPERATOR}/p/${r.id}`}>
            <img src={r.icon} alt="" />
            <span><b>{r.token} on {r.name}</b><small>{p ? `${n(p.budget?.escrowed_usd)} escrowed · ${n(p.totals.paid_usd)} paid · ${p.totals.paid_deliveries} deliveries` : r.note}</small></span>
            <strong>{p ? n(p.budget?.free_usd) : "…"}<small>{r.token} free</small></strong>
          </a>
        );
      })}
    </div>
  );
}

const FAQ = [
  { q: "What is a governor?", a: "A contract that holds an agent's budget for its owner. The owner sets the limits once; the agent's key can only act inside them, and every action outside them reverts on-chain with a named reason." },
  { q: "Can the agent withdraw the money?", a: "No. Only the owner's key can withdraw, change a limit or suspend the agent. The agent's key can call one function: buy, or for the Operator, open and pay deals inside the caps." },
  { q: "What happens when an agent hits a limit?", a: "The transaction reverts, and nothing moves. The explorer shows the governor's own reason, such as PerTradeCapExceeded or PriceAboveLimit, so anyone can see what was refused and why." },
  { q: "Which chains does it run on?", a: "The trading governor is on Base mainnet, and Solana has an anchored curve on mainnet beside a governor program on devnet. Monad, Robinhood Chain, Arc and Mezo run on testnet. The networks page lists every contract with its address." },
  { q: "How does the Operator decide who to pay?", a: "It checks the facts in code first: the author, the date, the deal's code, a merged pull request and an up-front #ad. Then a model reads the work against the owner's brief. Every payment carries the hash of that reasoning." },
  { q: "Is it audited?", a: "Not yet. The governor was fuzzed for 1,000,093 calls against a hostile venue and no property broke, but the contracts are unaudited. Keep mainnet budgets small." },
];

export function Landing() {
  // Header links point at sections as #/?to=<id>; the hash router re-renders this page, and it scrolls there.
  const to = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("to");
  useEffect(() => {
    if (to) requestAnimationFrame(() => document.getElementById(to)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [to]);

  return (
    <div className="s">
      <SiteHeader page="home" />
      <main>
        <section className="s-hero">
          <div className="s-hero-copy">
            <a className="s-news" href={`${OPERATOR}/p/quaestor-mezo`}><b><img src={brand("mezo.svg")} alt="" />New</b>Operator budgets in MUSD on Mezo, borrowed against Bitcoin<ArrowRight /></a>
            <h1 className="s-h1">Give your AI agent an allowance, not a wallet.</h1>
            <p className="s-lede">Quaestor holds an agent&rsquo;s budget in a contract its owner controls. A trading agent gets caps per trade and per day, a limit price and Chainlink&rsquo;s price on every fill. An agent that pays people gets escrow, and pays only for work it has checked. Anything outside the owner&rsquo;s limits reverts on-chain.</p>
            <div className="s-actions"><LaunchApp /><ReadDocs /></div>
          </div>
          <SceneBox scene="monad" className="s-hero-scene"><LiveAllowance /></SceneBox>
        </section>

        <div className="s-strip">
          <p className="s-strip-label">Live on six networks</p>
          <div className="s-strip-row">{CHAINS.map((c) => <Chip key={c.key} icon={c.icon} name={c.name} />)}</div>
        </div>

        <Reveal className="s-section" id="product">
          <SectionHead eyebrow="Two kinds of agent" title="One rule: the contract decides what an agent can spend." lede="The same model runs two products. One governs agents that trade; the other runs agents that pay people for work." />
          <div className="s-product">
            <div>
              <span className="s-eyebrow">For agents that trade</span>
              <h2 className="s-h2" style={{ marginTop: 14 }}>Inside caps it cannot raise.</h2>
              <p className="s-lede">The owner opens a governor with a budget, caps, the tokens and venues the agent may use, and a limit price. The governor measures what left and what arrived, checks Chainlink&rsquo;s price, and reverts the whole trade if any rule fails.</p>
              <ul className="s-ticks">
                <li><Check /><span>Uniswap on Base mainnet and Robinhood Chain, Kuru&rsquo;s order books on Monad, a governor program on Solana.</span></li>
                <li><Check /><span>The agent&rsquo;s key can buy and nothing else: no withdraw, no transfer, no approve.</span></li>
                <li><Check /><span>Each trade&rsquo;s reason is hashed on-chain and re-hashed in your browser.</span></li>
              </ul>
              <div className="s-on">{CHAINS.filter((c) => c.product !== "Operator").map((c) => <Chip key={c.key} icon={c.icon} name={c.name} />)}</div>
              <div className="s-actions"><TextLink href={MONAD}>Send the house agent a trade it must refuse</TextLink></div>
            </div>
            <SceneBox scene="base">
              <div className="s-glass s-refuse">
                <h4>What the governor says no with</h4>
                <p>Every refusal is a named revert, readable on the explorer.</p>
                <div className="s-codes">{REFUSALS.map((r) => <code key={r}>{r}</code>)}</div>
              </div>
            </SceneBox>
          </div>

          <div className="s-product s-product-flip">
            <div>
              <span className="s-eyebrow">For agents that pay people</span>
              <h2 className="s-h2" style={{ marginTop: 14 }}>Pay creators on proof.</h2>
              <p className="s-lede">Quaestor Operator runs a project&rsquo;s paid promotion from a budget in a payout governor. It offers a rate inside the owner&rsquo;s band, escrows the fee, and pays when the post, video or pull request is live, the payee&rsquo;s own, and says it is paid.</p>
              <ul className="s-ticks">
                <li><Check /><span>MUSD on Mezo, borrowed against Bitcoin instead of sold, with gas in BTC.</span></li>
                <li><Check /><span>USDC on Arc through a Circle wallet, paid on the payee&rsquo;s own chain over CCTP.</span></li>
                <li><Check /><span>Author, date, deal code and an up-front #ad are checked in code before a model reads the work.</span></li>
              </ul>
              <div className="s-on">{CHAINS.filter((c) => c.product === "Operator").map((c) => <Chip key={c.key} icon={c.icon} name={c.name} />)}</div>
              <div className="s-actions"><TextLink href={OPERATOR}>Apply to a paid task, or fund one</TextLink></div>
            </div>
            <SceneBox scene="mezo"><LiveBudgets /></SceneBox>
          </div>
        </Reveal>

        <Reveal className="s-section" id="how">
          <SectionHead eyebrow="How it works" title="The limits move on-chain." lede="The owner writes the rules once. The contract applies all of them to every action, measures what actually moved, and reverts when one fails." />
          <ol className="s-grid s-grid-4 s-steps">
            <li className="s-card"><h3 className="s-h3">The owner opens a governor</h3><p className="s-p">One transaction sets the budget, the caps, what the agent may buy or pay for, and the key it signs with.</p></li>
            <li className="s-card"><h3 className="s-h3">The agent asks</h3><p className="s-p">Its key can act inside the limits and nothing else. A hijacked agent has nothing to call.</p></li>
            <li className="s-card"><h3 className="s-h3">The contract measures</h3><p className="s-p">What left the budget and what arrived, against the caps, the limit price and Chainlink&rsquo;s price.</p></li>
            <li className="s-card"><h3 className="s-h3">The reason goes on-chain</h3><p className="s-p">Every settled action commits a hash of the agent&rsquo;s reason, and the app re-hashes the record.</p></li>
          </ol>
        </Reveal>

        <Reveal className="s-section" id="networks">
          <SectionHead eyebrow="End to end" title="What runs on each chain, today." lede="Every row is a deployed contract you can open on the explorer. Mainnet is labelled mainnet; everything else says which testnet." />
          <div className="s-matrix">
            <div className="s-matrix-row s-matrix-head"><span>Chain</span><span>What runs</span><span>Budget</span><span>Venue or route</span><span>Signer</span><span /></div>
            {CHAINS.map((c) => (
              <a key={c.key} className="s-matrix-row" href={c.app}>
                <span className="s-matrix-chain"><Chip icon={c.icon} name={c.name} /><span className={`s-pill${c.mainnet ? " s-pill-main" : ""}`}>{c.status}</span></span>
                <span>{c.product === "Operator" ? "Operator: pays people on proof" : c.product === "Governor + curve" ? "Governor, and an anchored curve" : "Trading governor"}</span>
                <span className="s-matrix-budget">{c.budget.icons.map((i) => <img key={i} src={i} alt="" />)}{c.budget.label}</span>
                <span>{c.venue}</span>
                <span>{c.signer}</span>
                <ArrowRight />
              </a>
            ))}
          </div>
          <div className="s-matrix-foot"><span>Built with</span><TextLink href="#/networks">Every contract, with its address</TextLink></div>
          <div className="s-strip-row s-strip-quiet" style={{ justifyContent: "flex-start", marginTop: 14 }}>{BUILT_WITH.map((b) => <Chip key={b.name} icon={b.icon} name={b.name} />)}</div>
        </Reveal>

        <Reveal className="s-section" id="agents">
          <SectionHead eyebrow="Bring your own agent" title="Any agent that can sign can work under a governor." lede="The commands refuse what the governor would refuse before they sign anything." />
          <div className="s-grid s-grid-4">
            <article className="s-card"><img src={brand("metamask.svg")} alt="" width={28} height={28} /><h3 className="s-h3" style={{ marginTop: 32 }}>MetaMask agent wallet</h3><p className="s-p">A plugin runs <code>mm quaestor buy</code> through the governor, with Guard Mode approval on top.</p></article>
            <article className="s-card"><Code2 width={28} height={28} /><h3 className="s-h3" style={{ marginTop: 32 }}>One skill, one CLI</h3><p className="s-p">Claude Code, Codex and Bankr&rsquo;s agent install the same skill: keygen, register, quote, buy. <a className="s-link" href={SKILL} target="_blank" rel="noreferrer">Read it <ArrowUpRight /></a></p></article>
            <article className="s-card"><Gauge width={28} height={28} /><h3 className="s-h3" style={{ marginTop: 32 }}>Price checks over x402</h3><p className="s-p">&ldquo;Is this quote fair?&rdquo; against live mainnet prices, from $0.001 a call, in USDC on Base or Solana.</p></article>
            <article className="s-card"><img src={brand("aurora.svg")} alt="" width={28} height={28} /><h3 className="s-h3" style={{ marginTop: 32 }}>Fund from any chain</h3><p className="s-p">Aurora Intents brings USDC from Base, Arbitrum, Ethereum or Solana straight into a governor.</p></article>
          </div>
        </Reveal>

        <Reveal className="s-section" id="proof">
          <SectionHead eyebrow="Built to be checked" title="Every claim resolves to evidence." lede="Echidna played the agent against a venue that does whatever it is told: pays honestly, pulls twice, overcharges, re-enters. Eight properties had to hold." />
          <div className="s-numbers">
            <div className="s-number s-card"><b>1,000,093</b><span>fuzzed calls</span><small>from a hostile venue; none broke a property</small></div>
            <div className="s-number s-card"><b>465 ms</b><span>proposed to final</span><small>a governed fill on Monad, from Alchemy&rsquo;s stream</small></div>
            <div className="s-number s-card"><b>{REFUSALS.length}</b><span>named refusals</span><small>each one a revert anyone can read on the explorer</small></div>
            <div className="s-number s-card"><b>1</b><span>key can withdraw</span><small>the owner&rsquo;s; the agent&rsquo;s key can only act inside the limits</small></div>
          </div>
        </Reveal>

        <Reveal className="s-section"><Faq items={FAQ} /></Reveal>

        <Close title="Give your agent an allowance." lede="Open a governor in one transaction, or fund a paid task on Mezo or Arc and let the Operator pay only for work that is done." />
      </main>
      <SiteFooter />
    </div>
  );
}
