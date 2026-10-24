import { CHAINS } from "./chains";
import { Close, Faq, Reveal, SceneBox, SectionHead, SiteFooter, SiteHeader } from "./parts";

const LINES: { what: string; how: string; state: string; live?: boolean }[] = [
  { what: "Testnets", how: "Governors, the Operator and every refusal, on Monad, Robinhood Chain, Arc, Mezo and Solana devnet.", state: "free", live: true },
  { what: "Governed trades", how: "10 basis points of each settled trade on mainnet, paid by the owner. Refused trades cost nothing.", state: "next, on mainnet" },
  { what: "Platforms", how: "An agent platform gives its users governors and adds its own fee; Quaestor keeps a fifth of it.", state: "next, on mainnet" },
  { what: "Price checks", how: "$0.001 to $0.005 a call over x402, through Bankr x402 Cloud and PayAI, in USDC on Base or Solana.", state: "live", live: true },
  { what: "Anchored curves", how: "Trading fees on the curves Quaestor launches; the first paid 11.60 USDC in five minutes.", state: "earning on Solana mainnet", live: true },
];

const FAQ = [
  { q: "Who pays the fee?", a: "The owner of the governor, per settled trade. The agent never holds the fee, and a refused trade pays nothing." },
  { q: "What does the Operator cost?", a: "Nothing on testnet today. The budget pays the people who deliver, and the agent pays the gas for opening the campaign and for each payment." },
  { q: "Where do the comparison figures come from?", a: "Each wallet's and bot's published swap fee, checked on 23 September 2026. They are fees per trade in basis points, before network gas." },
];

/** What Quaestor charges, kept off the home page. */
export function PricingPage() {
  const testnets = CHAINS.filter((c) => !c.mainnet).length;
  return (
    <div className="s">
      <SiteHeader page="pricing" />
      <main>
        <section className="s-page-hero">
          <span className="s-eyebrow">Pricing</span>
          <h1 className="s-h1">A tenth of a wallet&rsquo;s swap fee.</h1>
          <p className="s-lede">Governance is free on all {testnets} testnets. On mainnet the owner pays per settled trade, well under what wallets and trading bots take today.</p>
        </section>

        <section className="s-section" style={{ paddingTop: 40 }}>
          <div className="s-price">
            <SceneBox scene="arc">
              <div className="s-glass s-card s-price-big" style={{ background: "rgba(255,255,255,.66)", width: "min(420px, 100%)" }}>
                <b>10<em>bps</em></b>
                <p className="s-p">of each governed trade, on mainnet. Next, on mainnet.</p>
              </div>
            </SceneBox>
            <div className="s-card s-bars">
              <div><span>Telegram trading bots</span><i style={{ width: "100%" }} /><b>~100</b></div>
              <div><span>MetaMask swaps</span><i style={{ width: "87.5%" }} /><b>87.5</b></div>
              <div><span>Phantom swaps</span><i style={{ width: "85%" }} /><b>85</b></div>
              <div className="is-q"><span>Quaestor</span><i style={{ width: "10%" }} /><b>10</b></div>
              <small>basis points per trade · fees checked 23 Sep 2026</small>
            </div>
          </div>
        </section>

        <Reveal className="s-section s-section-tight">
          <SectionHead eyebrow="Every line" title="What is charged, and what is live." />
          <div className="s-lines">
            {LINES.map((l) => <div key={l.what}><b>{l.what}</b><span>{l.how}</span><span className={`s-pill${l.live ? " s-pill-main" : ""}`}>{l.state}</span></div>)}
          </div>
        </Reveal>

        <Reveal className="s-section"><Faq items={FAQ} /></Reveal>
        <Close title="Start on a testnet, for free." lede="Open a governor or fund an Operator budget with test tokens, and watch the contract refuse what you told it to." />
      </main>
      <SiteFooter />
    </div>
  );
}
