import { useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import {
  ArrowRight, ArrowUpRight, Bot, Check, Code2, Fingerprint, Gauge, KeyRound,
  Radio, Scale, ShieldCheck, Wallet, X,
} from "lucide-react";
import { explorerHref } from "../components/ExplorerShell";
import { fetchGovernor, fetchTrades, show, type GovernorView, type TradeRow } from "../lib/evm/stocks";

const GITHUB = "https://github.com/N-45div/Quaestor";
const SKILL = `${GITHUB}/tree/main/skills/quaestor-trading`;
const MONAD = "#/app/evm/monad-testnet";
const HOUSE = "0xD64E22Ff0D0dc311d89Bcc5C5113F9e7f149157C";   // the house agent's governor on Monad testnet: Kimi decides, Dynamic signs
const SOLANA_PROGRAM = "7whSJDtnCjhjPiBeLWoyVYHemtG1BnyBVfuJuuNDtFEG";
const DBC_POOL = "5cbDfFRGsAUUMGM5XJsKgkzZUJeLuD7H2QtkjkBXmz4N";

// What is deployed where, mainnet first. Each testnet is labelled a testnet.
const DEPLOYMENTS: { chain: string; what: string; address: string; href: string }[] = [
  { chain: "Base mainnet", what: "governor", address: "0x2e91d035D622d2ECa36B7836CBcf9651711B2D10", href: "https://basescan.org/address/0x2e91d035D622d2ECa36B7836CBcf9651711B2D10" },
  { chain: "Base mainnet", what: "decision log", address: "0x1219c62A56771CdCE7bb1f6e6a5ac05701DDF961", href: "https://basescan.org/address/0x1219c62A56771CdCE7bb1f6e6a5ac05701DDF961" },
  { chain: "Solana mainnet", what: "anchored Meteora curve", address: DBC_POOL, href: `https://explorer.solana.com/address/${DBC_POOL}` },
  { chain: "Monad testnet", what: "governor factory, on Kuru", address: "0x2e91d035D622d2ECa36B7836CBcf9651711B2D10", href: "https://testnet.monadscan.com/address/0x2e91d035D622d2ECa36B7836CBcf9651711B2D10" },
  { chain: "Robinhood Chain testnet", what: "governor factory, on Uniswap", address: "0x2B295A9DeAf3f91bCE7223294883fD55016D8580", href: "https://explorer.testnet.chain.robinhood.com/address/0x2B295A9DeAf3f91bCE7223294883fD55016D8580" },
  { chain: "Solana devnet", what: "stock governor program", address: SOLANA_PROGRAM, href: `https://explorer.solana.com/address/${SOLANA_PROGRAM}?cluster=devnet` },
];

// The governor's own refusals, as the contract names them.
const REFUSALS = ["PerTradeCapExceeded", "EpochCapExceeded", "InstrumentNotAllowed", "VenueNotAllowed", "PriceAboveLimit", "FillAboveOracle", "OracleStale", "MinimumOutputNotMet", "RouteOverspent", "AllowanceLeftBehind", "IntentAlreadyExecuted", "NotOperator"];

const jumpTo = (id: string) => (event: MouseEvent<HTMLAnchorElement>) => {
  event.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
};

/** Sections rise into place once, as they scroll into view. */
function Reveal({ children, className = "", as: Tag = "section", id }: { children: ReactNode; className?: string; as?: "section" | "div"; id?: string }) {
  const ref = useRef<HTMLElement | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { rootMargin: "0px 0px -12% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <Tag ref={ref as never} id={id} className={`${className} ql-reveal${seen ? " is-in" : ""}`}>{children}</Tag>;
}

/**
 * The house agent's allowance, read live from Monad testnet through the hub: its caps, what is left today, its latest
 * governed fill, and the refusal anyone can send it. A claim about a live system is better made by the system; if the
 * free host is waking, the card says so rather than showing numbers from nowhere.
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
    <div className="ql-allowance">
      <div className="ql-allowance-bar">
        <span><i className="ql-live-dot" />Live · Monad testnet</span>
        <a href={`${MONAD}/governors/${HOUSE}`}>governor {HOUSE.slice(0, 6)}…{HOUSE.slice(-4)} <ArrowUpRight /></a>
      </div>
      {gov ? <>
        <div className="ql-allowance-head">
          <small>THE HOUSE AGENT&rsquo;S ALLOWANCE</small>
          <div className="ql-allowance-left"><b>{show(gov.remaining)}</b><span>{unit} left today</span></div>
          <div className="ql-meter" aria-label={`${show(String(spent))} of ${show(String(cap))} ${unit} spent today`}><i style={{ width: `${cap ? Math.min(100, (100 * spent) / cap) : 0}%` }} /></div>
          <div className="ql-meter-legend"><span>{show(String(spent))} spent</span><span>cap {show(String(cap))} a day</span></div>
        </div>
        <dl className="ql-allowance-rules">
          <div><dt>Per trade</dt><dd>{show(gov.perTradeCap)} {unit}</dd></div>
          <div><dt>Stocks it may buy</dt><dd>{allowed.map((i) => i.symbol).join(" · ")}</dd></div>
          <div><dt>Chainlink guard</dt><dd>{guard ? `≤ ${guard.maxDeviationBps / 100}% over · ≤ ${Math.round(guard.maxStaleness / 3600)} h old` : "off"}</dd></div>
          <div><dt>Who can withdraw</dt><dd>the owner, only</dd></div>
        </dl>
        <div className="ql-outcomes">
          {last ? <a className="ql-outcome ql-outcome-ok" href={`${MONAD}/trades/${last.tx}`}>
            <span className="ql-outcome-icon"><Check /></span>
            <span><b>Settled</b> {show(last.spent)} {last.budget ?? unit} → {last.received} {last.stock} at {show(last.pricePerShare)}<small>reason committed on-chain · {last.decisionHash.slice(0, 10)}…</small></span>
            <ArrowRight />
          </a> : null}
          <a className="ql-outcome ql-outcome-no" href={MONAD}>
            <span className="ql-outcome-icon"><X /></span>
            <span><b>Refused</b> a hijacked buy at $400,000 a token<small>PriceAboveLimit · reverted on-chain · send one yourself</small></span>
            <ArrowRight />
          </a>
        </div>
      </> : <div className="ql-allowance-empty">{waking ? "The hosted hub is waking up; free instances sleep when idle. Give it a minute." : "Reading the governor from Monad testnet…"}</div>}
    </div>
  );
}

export function Landing() {
  return (
    <div className="ql">
      <header className="ql-header">
        <div className="ql-header-inner">
          <a className="ql-wordmark" href="#/" aria-label="Quaestor home">QU<span>Æ</span>STOR</a>
          <nav aria-label="Landing navigation">
            <a href="#how" onClick={jumpTo("how")}>How it works</a>
            <a href="#monad" onClick={jumpTo("monad")}>On Monad</a>
            <a href="#agents" onClick={jumpTo("agents")}>Your agent</a>
            <a href="#networks" onClick={jumpTo("networks")}>Networks</a>
            <a href="#business" onClick={jumpTo("business")}>Pricing</a>
            <a href="/blogs/">Blog</a>
          </nav>
          <div className="ql-header-end">
            <a className="ql-header-link" href={GITHUB} target="_blank" rel="noreferrer">Source <ArrowUpRight /></a>
            <a className="ql-nav-cta" href={MONAD}>Open the app <ArrowRight /></a>
          </div>
        </div>
      </header>

      <main>
        <section className="ql-hero">
          <div className="ql-hero-copy">
            <div className="ql-kicker"><Radio />Live on Monad · Base mainnet · Robinhood Chain · Solana</div>
            <h1>Don&rsquo;t give your agent a wallet. <em>Give it an allowance.</em></h1>
            <p>Quaestor holds an AI agent&rsquo;s budget in a governor contract its owner controls: a cap per trade and per day, the assets it may buy, a limit price, and Chainlink&rsquo;s price checked on every fill. The agent&rsquo;s key can ask to buy. Anything else reverts.</p>
            <div className="ql-actions">
              <a className="ql-button ql-button-primary" href={MONAD}>See it live on Monad <ArrowRight /></a>
              <a className="ql-button ql-button-secondary" href={`${MONAD}/register`}><KeyRound />Open a governor</a>
            </div>
            <div className="ql-built">
              <span>Built with</span>
              <p>Monad · Kuru · Chainlink CRE · Kimi · Dynamic · Alchemy · Envio · MetaMask · Aurora · Uniswap · Meteora</p>
            </div>
          </div>
          <LiveAllowance />
        </section>

        <Reveal className="ql-numbers" as="div">
          <div><strong>4</strong><span>chains live</span><small>Monad, Base mainnet, Robinhood Chain, Solana</small></div>
          <div><strong>465<em>ms</em></strong><span>proposed → final</span><small>a governed fill on Monad, from Alchemy&rsquo;s stream</small></div>
          <div><strong>1,000,093</strong><span>fuzzed calls</span><small>from a hostile venue; none broke a property</small></div>
          <div><strong>1</strong><span>key can withdraw</span><small>the owner&rsquo;s; the agent&rsquo;s key can only buy</small></div>
        </Reveal>

        <Reveal className="ql-section ql-problem">
          <div className="ql-section-head">
            <span className="ql-kicker">THE PROBLEM</span>
            <h2>A wallet is all or nothing.</h2>
            <p>An agent with a key can spend everything that key holds, at any price, on the word of one poisoned web page, one bad quote or one wrong decision.</p>
          </div>
          <div className="ql-problem-grid">
            <article><span className="ql-num">01</span><h3>Prompts get talked past</h3><p>&ldquo;Never spend more than $50&rdquo; is a sentence in the context window. The next sentence can override it.</p></article>
            <article><span className="ql-num">02</span><h3>Servers share the agent&rsquo;s fate</h3><p>A policy service beside the agent is one more thing to compromise, and it never sees what a trade actually returned.</p></article>
            <article><span className="ql-num">03</span><h3>Keys cannot say no to a price</h3><p>A signature authorises a call. It does not know that the order book it is filling against was opened by an attacker.</p></article>
          </div>
        </Reveal>

        <Reveal className="ql-section ql-how" id="how">
          <div className="ql-section-head ql-section-head-row">
            <div><span className="ql-kicker">HOW IT WORKS</span><h2>The limits move on-chain.</h2></div>
            <p>The owner writes the rules once. The contract applies all of them to every trade, measures what actually arrived, and reverts the whole trade when one fails.</p>
          </div>
          <ol className="ql-steps">
            <li><span className="ql-num">01</span><Wallet /><h3>The owner opens a governor</h3><p>One transaction: the budget, a cap per trade and per day, the stocks the agent may buy, a limit price for each, a Chainlink guard, and the agent&rsquo;s gas.</p></li>
            <li><span className="ql-num">02</span><Bot /><h3>The agent asks to buy</h3><p>Its key can call one function. It cannot withdraw, transfer, approve or change a limit, so a hijacked agent has nothing to call.</p></li>
            <li><span className="ql-num">03</span><Scale /><h3>The governor measures the fill</h3><p>What left the budget and what arrived, against the caps, the owner&rsquo;s limit price and Chainlink&rsquo;s price. A venue that overcharges is undone.</p></li>
            <li><span className="ql-num">04</span><Fingerprint /><h3>The reason goes on-chain</h3><p>Every settled trade commits a hash of the agent&rsquo;s reason. The app re-hashes the record in your browser and shows whether it matches.</p></li>
          </ol>
          <div className="ql-refusals">
            <div><span className="ql-kicker">WHAT THE CONTRACT SAYS NO WITH</span><p>Every refusal is a named revert anyone can read on the explorer.</p></div>
            <div className="ql-codes">{REFUSALS.map((r) => <code key={r}>{r}</code>)}</div>
          </div>
        </Reveal>

        <Reveal className="ql-section ql-monad" id="monad">
          <div className="ql-section-head ql-section-head-row">
            <div><span className="ql-kicker">ON MONAD</span><h2>Every rule, on every trade, in under a second.</h2></div>
            <p>Monad makes it cheap to run every check on every fill. Quaestor opened five markets on Kuru&rsquo;s order book and runs its own agent against them.</p>
          </div>
          <div className="ql-stack">
            <a href={MONAD}><small>Venue</small><b>Kuru</b><span>Five order books Quaestor opened and quotes: tETH, tTSLA, tNVDA, tSPY, tAAPL.</span></a>
            <a href={MONAD}><small>Decides</small><b>Kimi</b><span>kimi-k2.6 reads the portfolio and live Kuru quotes beside Chainlink, and buys at most one stock a run.</span></a>
            <a href={MONAD}><small>Signs</small><b>Dynamic</b><span>The agent&rsquo;s key is a two-of-two MPC wallet, split between Quaestor&rsquo;s server and Dynamic.</span></a>
            <a href={MONAD}><small>Prices</small><b>Chainlink CRE</b><span>A workflow brings NVDA, SPY and AAPL from Arbitrum, then starts the agent over Confidential HTTP.</span></a>
            <a href={MONAD}><small>Streams</small><b>Alchemy</b><span>Each governed fill shows the moment its block is proposed, and again when it is final.</span></a>
            <a href={MONAD}><small>Indexes</small><b>Envio</b><span>HyperIndex tracks every governor, trade and price write, and the app reads it live.</span></a>
          </div>
          <div className="ql-actions"><a className="ql-button ql-button-primary" href={MONAD}>Send the house agent a trade it must refuse <ArrowRight /></a></div>
        </Reveal>

        <Reveal className="ql-section ql-agents" id="agents">
          <div className="ql-section-head ql-section-head-row">
            <div><span className="ql-kicker">BRING YOUR OWN AGENT</span><h2>Your agent, your governor, your limits.</h2></div>
            <p>Any agent that can sign a transaction can trade under a governor. The commands refuse what the governor would refuse before they sign anything.</p>
          </div>
          <div className="ql-agent-grid">
            <article><Wallet /><h3>MetaMask Agent Wallet</h3><p>A plugin runs <code>mm quaestor buy</code> through the governor, with Guard Mode approval on top. A buy over the cap is refused before MetaMask is asked.</p></article>
            <article><Code2 /><h3>One skill, one CLI</h3><p>Claude Code, Codex and Bankr&rsquo;s agent install the same skill: <code>keygen</code>, <code>register</code>, <code>quote</code>, <code>buy</code>. The owner signs one link.</p><a href={SKILL} target="_blank" rel="noreferrer">Read the skill <ArrowUpRight /></a></article>
            <article><Gauge /><h3>Price checks over x402</h3><p>&ldquo;Is this quote fair?&rdquo; for a quote from any venue, against live mainnet prices, from $0.001 a call, in USDC on Base or Solana.</p></article>
            <article><ShieldCheck /><h3>Fund from any chain</h3><p>Aurora Intents brings USDC from Base, Arbitrum, Ethereum or Solana straight into a governor, where it is the agent&rsquo;s budget the moment it lands. NEAR Intents has Monad paused today, and the app says so.</p></article>
          </div>
        </Reveal>

        <Reveal className="ql-section ql-networks" id="networks">
          <div className="ql-section-head ql-section-head-row">
            <div><span className="ql-kicker">NETWORKS</span><h2>One model, native on every chain.</h2></div>
            <p>An owner sets limits, a contract enforces them, and every settled trade points at its reason. What is on mainnet is labelled mainnet, and nothing else is.</p>
          </div>
          <div className="ql-network-grid">
            <a href={MONAD} className="ql-network"><div><i className="dot-monad" />Monad<ArrowUpRight /></div><strong>Stocks on Kuru, a house agent run by Kimi and Dynamic</strong><small>testnet</small></a>
            <a href={explorerHref("/", "base")} className="ql-network"><div><i className="dot-base" />Base<ArrowUpRight /></div><strong>The spend governor, with Cato trading on the real Uniswap</strong><small>mainnet</small></a>
            <a href="#/app/evm/robinhood-testnet" className="ql-network"><div><i className="dot-robinhood" />Robinhood Chain<ArrowUpRight /></div><strong>Tokenized stocks on Uniswap, priced by Chainlink</strong><small>testnet · fork-tested on mainnet</small></a>
            <a href={explorerHref("/stocks")} className="ql-network"><div><i className="dot-solana" />Solana<ArrowUpRight /></div><strong>A stock governor program, and an anchored launch curve</strong><small>devnet governor · mainnet curve</small></a>
          </div>
          <div className="ql-ledger">
            <div className="ql-ledger-title"><span>Deployments</span><small>full addresses, from the deployment files</small></div>
            <div className="ql-ledger-rows">
              {DEPLOYMENTS.map((d) => <a key={`${d.chain}-${d.what}`} href={d.href} target="_blank" rel="noreferrer"><span>{d.chain}</span><span>{d.what}</span><code>{d.address}</code><ArrowUpRight /></a>)}
            </div>
          </div>
        </Reveal>

        <Reveal className="ql-section ql-business" id="business">
          <div className="ql-section-head ql-section-head-row">
            <div><span className="ql-kicker">PRICING</span><h2>A tenth of a wallet&rsquo;s swap fee.</h2></div>
            <p>Governance is free on testnets. On mainnet, the owner pays per settled trade, well under what wallets and trading bots take today.</p>
          </div>
          <div className="ql-price-grid">
            <div className="ql-price-hero"><strong>10<em>bps</em></strong><span>of each governed trade, on mainnet</span><small>next, on mainnet</small></div>
            <div className="ql-bars">
              <div><span>Telegram trading bots</span><i style={{ width: "100%" }} /><b>~100</b></div>
              <div><span>MetaMask swaps</span><i style={{ width: "87.5%" }} /><b>87.5</b></div>
              <div><span>Phantom swaps</span><i style={{ width: "85%" }} /><b>85</b></div>
              <div className="is-q"><span>Quaestor</span><i style={{ width: "10%" }} /><b>10</b></div>
              <small>basis points per trade · fees checked 23 Sep 2026</small>
            </div>
          </div>
          <div className="ql-lines">
            <div><b>Platforms</b><span>An agent platform gives its users governors and adds its own fee; Quaestor keeps a fifth of it.</span><em>next, on mainnet</em></div>
            <div><b>Price checks</b><span>$0.001 to $0.005 a call over x402, through Bankr x402 Cloud and PayAI.</span><em className="is-live">live</em></div>
            <div><b>Anchored curves</b><span>Trading fees on the curves Quaestor launches; the first paid 11.60 USDC in five minutes.</span><em className="is-live">earning on Solana mainnet</em></div>
          </div>
        </Reveal>

        <Reveal className="ql-section ql-evidence">
          <div className="ql-evidence-copy">
            <span className="ql-kicker">BUILT TO BE CHECKED</span><h2>Every claim resolves to evidence.</h2>
            <p>Echidna played the agent against a venue that does whatever it is told: pays honestly, pulls twice, overcharges, re-enters. Eight properties had to hold. A campaign of 1,000,093 calls broke none.</p>
            <div className="ql-actions"><a className="ql-button ql-button-primary" href={MONAD}>Inspect live trades <ArrowRight /></a><a className="ql-button ql-button-secondary" href={GITHUB} target="_blank" rel="noreferrer"><Code2 />Read the source</a></div>
          </div>
          <ul className="ql-evidence-list">
            <li><Check /><span><b>Measured, not trusted</b>The governor reads its own balances around the venue call; a shortfall or an overcharge reverts.</span></li>
            <li><Check /><span><b>Chainlink on every fill</b>A fill too far over Chainlink&rsquo;s price, or a price older than the owner allows, is refused.</span></li>
            <li><Check /><span><b>Reasons outlive hosts</b>The decision hash is in the trade&rsquo;s event; the record re-hashes in the browser.</span></li>
            <li><Check /><span><b>Honest boundary</b>The contracts are unaudited. The stock governors run on testnets and Solana devnet, with test tokens; Base&rsquo;s governor and the Solana curve are on mainnet.</span></li>
          </ul>
        </Reveal>

        <section className="ql-final">
          <h2>Don&rsquo;t give your agent a wallet.<br /><em>Give it an allowance.</em></h2>
          <div className="ql-actions"><a className="ql-button ql-button-primary" href={MONAD}>Open the app <ArrowRight /></a><a className="ql-button ql-button-secondary" href={`${MONAD}/register`}><KeyRound />Open a governor</a></div>
        </section>
      </main>

      <footer className="ql-footer">
        <a className="ql-wordmark" href="#/">QU<span>Æ</span>STOR</a>
        <p>Spending limits an AI agent cannot talk its way past.</p>
        <div><a href={MONAD}>App</a><a href="/blogs/">Blog</a><a href={GITHUB} target="_blank" rel="noreferrer">Source <ArrowUpRight /></a></div>
      </footer>
    </div>
  );
}
