import { ArrowUpRight } from "lucide-react";
import { BUILT_WITH, CHAINS } from "./chains";
import { Chip, Close, Reveal, SiteFooter, SiteHeader, TextLink } from "./parts";

/** Every chain end to end: what runs there, in what token, through what venue, signed by what, at which addresses. */
export function NetworksPage() {
  return (
    <div className="s">
      <SiteHeader page="networks" />
      <main>
        <section className="s-page-hero">
          <span className="s-eyebrow">Networks</span>
          <h1 className="s-h1">Six networks, one model of control.</h1>
          <p className="s-lede">On every chain an owner sets the limits, a contract enforces them, and every settled action points at its reason. Each address below is from the deployment files in the repository and opens on that chain&rsquo;s explorer.</p>
          <div className="s-strip-row" style={{ justifyContent: "flex-start", marginTop: 28 }}>{CHAINS.map((c) => <a key={c.key} href={`#/networks?to=${c.key}`} onClick={(e) => { e.preventDefault(); document.getElementById(c.key)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}><Chip icon={c.icon} name={c.name} /></a>)}</div>
        </section>

        <section className="s-section" style={{ paddingTop: 48 }}>
          {CHAINS.map((c) => (
            <Reveal as="div" key={c.key} id={c.key} className="s-chain">
              <div className="s-chain-scene" data-scene={c.key}>
                <div className="s-glass s-chain-badge">
                  <img src={c.icon} alt="" />
                  <b>{c.name}</b>
                  <span className={`s-pill${c.mainnet ? " s-pill-main" : ""}`}>{c.status}</span>
                </div>
              </div>
              <div className="s-chain-body">
                <span className="s-eyebrow">{c.product === "Operator" ? "Operator" : c.product === "Governor + curve" ? "Governor and anchored curve" : "Trading governor"}</span>
                <h2 className="s-h3" style={{ marginTop: 12, fontSize: 24 }}>{c.name}</h2>
                <p className="s-p">{c.summary}</p>
                <dl className="s-facts">
                  <div><dt>Budget</dt><dd>{c.budget.label}</dd></div>
                  <div><dt>Venue or route</dt><dd>{c.venue}</dd></div>
                  <div><dt>Prices</dt><dd>{c.prices}</dd></div>
                  <div><dt>Signer</dt><dd>{c.signer}</dd></div>
                  <div><dt>Decides</dt><dd>{c.decides}</dd></div>
                </dl>
                <div className="s-contracts">
                  {c.contracts.map((k) => <a key={k.label} href={k.href} target="_blank" rel="noreferrer"><span>{k.label}</span><code>{k.address}</code><ArrowUpRight /></a>)}
                </div>
                <div className="s-actions"><TextLink href={c.app}>Open {c.name} in the app</TextLink></div>
              </div>
            </Reveal>
          ))}
        </section>

        <Reveal className="s-section">
          <div className="s-head"><span className="s-eyebrow">Built with</span><h2 className="s-h2" style={{ marginTop: 14 }}>The parts it stands on.</h2></div>
          <div className="s-strip-row" style={{ justifyContent: "flex-start" }}>{BUILT_WITH.map((b) => <Chip key={b.name} icon={b.icon} name={b.name} />)}</div>
        </Reveal>

        <Close title="Pick a chain, open a governor." lede="Testnet budgets use test tokens with no value. On mainnet, start small: the contracts are unaudited." />
      </main>
      <SiteFooter />
    </div>
  );
}
