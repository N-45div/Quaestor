import { BadgeCheck, Coins, FileCheck2, ShieldCheck } from "lucide-react";
import { opHref } from "../../lib/operator";

/** The deciding model by name, for people reading how it works. */
const modelName = (model?: string | null) => (model?.startsWith("kimi") ? "Kimi" : model?.startsWith("claude") ? "Claude" : "The operator's model");
import { useOp } from "./OperatorPages";

export function OpHome() {
  const { index } = useOp();
  return <>
    <section className="page-intro compact"><div>
      <span className="eyebrow">QUAESTOR OPERATOR · ARC</span>
      <h1>An AI operator for your project&rsquo;s paid outreach</h1>
      <p>
        Fund a USDC budget on Arc and list what you will pay for: a post, a pull request, an article, a video. People apply.
        The operator decides who to work with and what to offer inside your rate bands, escrows each deal on-chain, checks what
        was delivered, and pays for it, here or on the payee&rsquo;s own chain. It cannot spend past the limits your contract sets,
        and it never writes to anyone first.
      </p>
    </div></section>

    <section className="onboard-steps op-steps" aria-label="How it works">
      <article><span>01</span><Coins size={18} /><h3>You fund a budget</h3><p>A payout governor holds your USDC with caps per deal, per week and for anyone new. You keep the owner key: approve, suspend or withdraw at any time.</p></article>
      <article><span>02</span><BadgeCheck size={18} /><h3>It screens and offers</h3><p>{modelName(index.model)} reads each application and the applicant&rsquo;s samples, and offers a rate inside your band, or asks you. A deal over its limits waits for your signature.</p></article>
      <article><span>03</span><FileCheck2 size={18} /><h3>It checks, then pays</h3><p>The author, the date, the merge and the deal&rsquo;s own code are checked in code before the model judges the work. Payment goes out with the decision&rsquo;s hash on-chain.</p></article>
      <article><span>04</span><ShieldCheck size={18} /><h3>Anyone can audit it</h3><p>Every payment links to the record of why it was made; re-hash it and it matches the chain. You get a heads-up for anything it would not decide alone, and a weekly brief.</p></article>
    </section>

    <section className="data-section">
      <div className="section-heading"><div><span className="eyebrow">PROJECTS</span><h2>Paying for work now</h2></div>
        <a className="btn btn-gold btn-sm" href={opHref("/new")}>Start a project</a></div>
      <div className="op-project-grid">
        {index.projects.map((p) => (
          <a key={p.id} className="op-project-card" href={opHref(`/p/${p.id}`)}>
            <strong>{p.name}</strong>
            <span>{index.networks.find((n) => n.key === p.network)?.name ?? p.network}</span>
            <small>Open tasks and how it pays →</small>
          </a>
        ))}
        {!index.projects.length && <p className="muted-copy">No project yet. <a href={opHref("/new")}>Start the first.</a></p>}
      </div>
      {!index.deciding && <p className="muted-copy op-note">The operator&rsquo;s model is not configured on this hub yet: applications are kept, and decided once it is.</p>}
    </section>
  </>;
}
