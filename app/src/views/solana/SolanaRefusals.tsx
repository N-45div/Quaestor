import { ArrowUpRight, ShieldX } from "lucide-react";
import { REFUSALS, explorerUrl } from "../../lib/solana/devnet";

/**
 * What the program would not let through. Every row in the trades tables is a
 * trade that passed; the point of a governor is the ones that did not, and on
 * a block explorer those look like any failed transaction. Each card names the
 * check that refused it and the log line that proves it.
 */
export function SolanaRefusals() {
  return (
    <section className="data-section refusals-section">
      <div className="section-heading"><div><span className="eyebrow">REFUSED ON CHAIN</span><h2>What the program would not let through</h2></div><span className="row-count">Devnet transactions</span></div>
      <p className="muted-copy refusals-intro">A refused trade moves nothing and leaves no record, so it is not in the tables below. On the explorer each shows as a failed transaction; its logs name the check.</p>
      <div className="refusal-grid">
        {REFUSALS.map((r) => (
          <article key={r.signature}>
            <div className="refusal-top"><ShieldX size={16} /><code>{r.code}</code></div>
            <p>{r.what}</p>
            <div className="refusal-proof">
              <span>Logs: <code>Error Code: {r.code}</code> · custom error {r.errorNumber}</span>
              <a className="mono-link" href={explorerUrl("tx", r.signature)} target="_blank" rel="noreferrer">{r.signature.slice(0, 8)}…<ArrowUpRight size={12} /></a>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
