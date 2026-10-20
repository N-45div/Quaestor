import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowRight, ArrowUpRight, Plus } from "lucide-react";
import { APP, GITHUB, brand, type Scene } from "./chains";
import "./site.css";

/** The site's pages, as the hash router names them. */
export type SitePage = "home" | "networks" | "pricing";

const DOCS = `${GITHUB}#readme`;
const SKILL = `${GITHUB}/tree/main/skills/quaestor-trading`;

/** The one primary action, labelled the same everywhere. */
export const LaunchApp = ({ small }: { small?: boolean }) => (
  <a className={`s-btn s-btn-primary${small ? " s-btn-sm" : ""}`} href={APP}>Launch app <ArrowRight /></a>
);

export const ReadDocs = () => (
  <a className="s-btn s-btn-quiet" href={DOCS} target="_blank" rel="noreferrer">Read the docs <ArrowUpRight /></a>
);

/** A text link; external ones open in a new tab and say so with their arrow. */
export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  const out = /^https?:/.test(href);
  return <a className="s-link" href={href} {...(out ? { target: "_blank", rel: "noreferrer" } : {})}>{children}{out ? <ArrowUpRight /> : <ArrowRight />}</a>;
}

/** A chain's or a partner's mark with its name. */
export const Chip = ({ icon, name }: { icon: string; name: string }) => (
  <span className="s-chip"><img src={icon} alt="" width={20} height={20} loading="lazy" />{name}</span>
);

/** A block that rises into place once, the first time it scrolls into view. */
export function Reveal({ children, className = "", id, as: Tag = "section" }: { children: ReactNode; className?: string; id?: string; as?: "section" | "div" }) {
  const ref = useRef<HTMLElement | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { rootMargin: "0px 0px -10% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <Tag ref={ref as never} id={id} className={`${className} s-reveal${seen ? " is-in" : ""}`}>{children}</Tag>;
}

/** Eyebrow, display heading and lede: every section opens the same way. */
export function SectionHead({ eyebrow, title, lede, center }: { eyebrow: string; title: ReactNode; lede?: ReactNode; center?: boolean }) {
  return (
    <div className={`s-head${center ? " s-head-center" : ""}`}>
      <span className="s-eyebrow">{eyebrow}</span>
      <h2 className="s-h2">{title}</h2>
      {lede ? <p className="s-lede">{lede}</p> : null}
    </div>
  );
}

/** A chain's gradient with grain, holding a frosted card. */
export const SceneBox = ({ scene, className = "", children }: { scene: Scene | "ink"; className?: string; children: ReactNode }) => (
  <div className={`s-scene ${className}`} data-scene={scene}>{children}</div>
);

export function SiteHeader({ page }: { page: SitePage }) {
  const current = (p: SitePage) => (p === page ? { "aria-current": "page" as const } : {});
  return (
    <header className="s-header">
      <div className="s-header-in">
        <a className="s-mark" href="#/" aria-label="Quaestor home"><i>Q</i>Quaestor</a>
        <nav className="s-nav" aria-label="Site">
          <a href="#/?to=product">Product</a>
          <a href="#/?to=how">How it works</a>
          <a href="#/networks" {...current("networks")}>Networks</a>
          <a href="#/pricing" {...current("pricing")}>Pricing</a>
          <a href="/blogs/">Blog</a>
        </nav>
        <div className="s-header-end">
          <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
          <LaunchApp small />
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="s-footer">
      <div>
        <a className="s-mark" href="#/"><i>Q</i>Quaestor</a>
        <p>Spending limits for AI agents, enforced on-chain. The contract decides what an agent can spend, not a server.</p>
      </div>
      <div>
        <h5>Product</h5>
        <ul>
          <li><a href="#/app/evm/monad-testnet">Trading governor</a></li>
          <li><a href="#/app/operator">Operator</a></li>
          <li><a href="#/networks">Networks</a></li>
          <li><a href="#/pricing">Pricing</a></li>
        </ul>
      </div>
      <div>
        <h5>Developers</h5>
        <ul>
          <li><a href={GITHUB} target="_blank" rel="noreferrer">Source on GitHub</a></li>
          <li><a href={SKILL} target="_blank" rel="noreferrer">Agent skill and CLI</a></li>
          <li><a href="/blogs/">Blog</a></li>
        </ul>
      </div>
      <div>
        <h5>Live</h5>
        <ul>
          <li><a href="#/app?chain=base">Base mainnet</a></li>
          <li><a href="#/app/evm/monad-testnet">Monad testnet</a></li>
          <li><a href="#/app/operator/p/quaestor">Arc testnet</a></li>
          <li><a href="#/app/operator/p/quaestor-mezo">Mezo testnet</a></li>
        </ul>
      </div>
      <p className="s-footer-note">The contracts are unaudited. Testnets use test tokens with no value; Base and the Solana curve are on mainnet.</p>
    </footer>
  );
}

/** Questions, each opening in place. */
export function Faq({ items }: { items: { q: string; a: ReactNode }[] }) {
  return (
    <div className="s-faq">
      <div><span className="s-eyebrow">FAQ</span><h2 className="s-h2" style={{ marginTop: 14 }}>Questions</h2></div>
      <div>
        {items.map((it) => (
          <details key={it.q}>
            <summary>{it.q}<Plus /></summary>
            <p>{it.a}</p>
          </details>
        ))}
      </div>
    </div>
  );
}

/** The closing band: one statement and the one action. */
export function Close({ title, lede }: { title: ReactNode; lede: ReactNode }) {
  return (
    <section className="s-close" data-scene="ink">
      <h2 className="s-h2">{title}</h2>
      <p className="s-lede">{lede}</p>
      <div className="s-actions"><LaunchApp /><a className="s-btn s-btn-quiet" href={GITHUB} target="_blank" rel="noreferrer">Source on GitHub <ArrowUpRight /></a></div>
    </section>
  );
}

export { brand };
