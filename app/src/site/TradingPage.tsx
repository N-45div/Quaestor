import { ArrowRight, ArrowUpRight, Check, Code2, Gauge } from "lucide-react";
import { LiveAllowance } from "../views/Landing";
import { CHAINS, GITHUB, REFUSALS, brand } from "./chains";
import { Chip, Close, Faq, LaunchApp, ReadDocs, Reveal, SceneBox, SectionHead, SiteFooter, SiteHeader, TextLink } from "./parts";

/**
 * Quaestor for agents that trade, at quaestor.dev/trading: the house agent's live allowance on Monad, the chains and
 * venues it runs on, what the governor checks on every fill, and the refusals it answers with.
 */
const MONAD = "/#/app/evm/monad-testnet";
const SKILL = `${GITHUB}/tree/main/skills/quaestor-trading`;
const TRADING = CHAINS.filter((c) => c.product !== "Operator");

const FAQ = [
  { q: "What can the agent's key do?", a: "Buy, inside the owner's limits, and nothing else. It cannot withdraw, transfer, approve or change a limit, so a hijacked agent has nothing useful to call." },
  { q: "How is a bad fill caught?", a: "The governor reads its own balances around the venue call: what left the budget and what arrived. A fill above the owner's limit price, too far over Chainlink's price, or on a price older than the owner allows, reverts the whole trade." },
  { q: "Where does it run?", a: "The spend governor is on Base mainnet, with Cato trading on Uniswap v3. Tokenized stocks run on Monad (Kuru's order books) and Robinhood Chain (Uniswap) testnets, and a governor program runs on Solana devnet." },
  { q: "Is it audited?", a: "Not yet. Echidna ran 1,000,093 calls from a hostile venue and no property broke, but the contracts are unaudited. Keep mainnet budgets small." },
];

export function TradingPage() {
  return (
    <div className="s">
      <SiteHeader page="trading" />
      <main>
        <section className="s-hero">
          <div className="s-hero-copy">
            <span className="s-eyebrow">Quaestor for agents that trade</span>
            <h1 className="s-h1">Agents that trade inside caps they cannot raise.</h1>
            <p className="s-lede">The owner opens a governor with a budget, caps per trade and per day, the tokens and venues the agent may use, and a limit price. The governor measures every fill against Chainlink&rsquo;s price and reverts the whole trade when a rule fails.</p>
            <div className="s-actions"><LaunchApp /><ReadDocs /></div>
          </div>
          <SceneBox scene="monad" className="s-hero-scene"><LiveAllowance /></SceneBox>
        </section>

        <div className="s-strip">
          <p className="s-strip-label">Live on</p>
          <div className="s-strip-row">{TRADING.map((c) => <Chip key={c.key} icon={c.icon} name={c.name} />)}</div>
          <div className="s-strip-row s-strip-quiet" style={{ marginTop: 14 }}>
            <Chip icon={brand("uniswap.svg")} name="Uniswap" /><Chip icon={brand("kuru.png")} name="Kuru" /><Chip icon={brand("meteora.svg")} name="Meteora" /><Chip icon={brand("chainlink.svg")} name="Chainlink" /><Chip icon={brand("dynamic.png")} name="Dynamic" /><Chip icon={brand("metamask.svg")} name="MetaMask" />
          </div>
        </div>

        <Reveal className="s-section" id="how">
          <SectionHead eyebrow="How it works" title="The limits move on-chain." lede="The owner writes the rules once. The contract applies all of them to every trade, measures what actually arrived, and reverts the whole trade when one fails." />
          <ol className="s-grid s-grid-4 s-steps">
            <li className="s-card"><h3 className="s-h3">The owner opens a governor</h3><p className="s-p">The budget, a cap per trade and per day, the stocks the agent may buy, a limit price for each, a Chainlink guard, and the agent&rsquo;s gas.</p></li>
            <li className="s-card"><h3 className="s-h3">The agent asks to buy</h3><p className="s-p">Its key can call one function. A hijacked agent has nothing else to call.</p></li>
            <li className="s-card"><h3 className="s-h3">The governor measures the fill</h3><p className="s-p">What left the budget and what arrived, against the caps, the owner&rsquo;s limit price and Chainlink&rsquo;s price.</p></li>
            <li className="s-card"><h3 className="s-h3">The reason goes on-chain</h3><p className="s-p">Every settled trade commits a hash of the agent&rsquo;s reason, and the app re-hashes the record.</p></li>
          </ol>
        </Reveal>

        <Reveal className="s-section">
          <div className="s-product">
            <div>
              <span className="s-eyebrow">Refused, not filled badly</span>
              <h2 className="s-h2" style={{ marginTop: 14 }}>Every refusal has a name.</h2>
              <p className="s-lede">A trade outside the owner&rsquo;s limits reverts with the governor&rsquo;s own reason, readable on the explorer. Send the house agent a trade it must refuse and watch the chain say no.</p>
              <div className="s-actions"><TextLink href={MONAD}>Send it a hijacked buy</TextLink></div>
            </div>
            <SceneBox scene="base">
              <div className="s-glass s-refuse">
                <h4>What the governor says no with</h4>
                <p>Each one a revert anyone can read on the explorer.</p>
                <div className="s-codes">{REFUSALS.map((r) => <code key={r}>{r}</code>)}</div>
              </div>
            </SceneBox>
          </div>
        </Reveal>

        <Reveal className="s-section" id="networks">
          <SectionHead eyebrow="End to end" title="Where agents trade under a governor." lede="Every row is a deployed contract; mainnet is labelled mainnet." />
          <div className="s-matrix">
            <div className="s-matrix-row s-matrix-head"><span>Chain</span><span>What runs</span><span>Budget</span><span>Venue or route</span><span>Signer</span><span /></div>
            {TRADING.map((c) => (
              <a key={c.key} className="s-matrix-row" href={c.app}>
                <span className="s-matrix-chain"><Chip icon={c.icon} name={c.name} /><span className={`s-pill${c.mainnet ? " s-pill-main" : ""}`}>{c.status}</span></span>
                <span>{c.product === "Governor + curve" ? "Governor, and an anchored curve" : "Trading governor"}</span>
                <span className="s-matrix-budget">{c.budget.icons.map((i) => <img key={i} src={i} alt="" />)}{c.budget.label}</span>
                <span>{c.venue}</span>
                <span>{c.signer}</span>
                <ArrowRight />
              </a>
            ))}
          </div>
        </Reveal>

        <Reveal className="s-section">
          <SectionHead eyebrow="Bring your own agent" title="Any agent that can sign can trade under a governor." lede="The commands refuse what the governor would refuse before they sign anything." />
          <div className="s-grid s-grid-4">
            <article className="s-card"><img src={brand("metamask.svg")} alt="" width={28} height={28} /><h3 className="s-h3" style={{ marginTop: 32 }}>MetaMask agent wallet</h3><p className="s-p">A plugin runs <code>mm quaestor buy</code> through the governor, with Guard Mode approval on top.</p></article>
            <article className="s-card"><Code2 width={28} height={28} /><h3 className="s-h3" style={{ marginTop: 32 }}>One skill, one CLI</h3><p className="s-p">Claude Code, Codex and Bankr&rsquo;s agent install the same skill. <a className="s-link" href={SKILL} target="_blank" rel="noreferrer">Read it <ArrowUpRight /></a></p></article>
            <article className="s-card"><Gauge width={28} height={28} /><h3 className="s-h3" style={{ marginTop: 32 }}>Price checks over x402</h3><p className="s-p">&ldquo;Is this quote fair?&rdquo; against live mainnet prices, from $0.001 a call.</p></article>
            <article className="s-card"><Check width={28} height={28} /><h3 className="s-h3" style={{ marginTop: 32 }}>Fuzzed against a hostile venue</h3><p className="s-p">1,000,093 calls from a venue that pulls twice, overcharges and re-enters; no property broke.</p></article>
          </div>
        </Reveal>

        <Reveal className="s-section"><Faq items={FAQ} /></Reveal>
        <Close title="Give your trading agent an allowance." lede="Open a governor in one transaction on Monad or Robinhood Chain testnet, or watch Cato trade inside its caps on Base mainnet." />
      </main>
      <SiteFooter />
    </div>
  );
}
