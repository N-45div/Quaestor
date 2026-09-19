import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { fetchIntel, type IntelIndexView } from "../lib/stocks";

const SKILL_URL = "https://gitlab.com/ndivij2004/quaestor/-/tree/main/skills/quaestor-trading";

function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_600);
    });
  };
  return <div className="aa-line">
    <span>{label}</span>
    <code>{value}</code>
    <button type="button" onClick={copy} aria-label={`Copy ${label}`}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
  </div>;
}

/**
 * How an agent gets in, and what it can buy once it is there.
 *
 * Two doors. Anyone's agent can connect with no key and use every tool that
 * reads; trading needs the owner's key. And separately from governance, which
 * is free, the hub sells judgement per call on two payment rails.
 */
export function AgentAccess({ base }: { base: string }) {
  const [intel, setIntel] = useState<IntelIndexView | null>(null);

  useEffect(() => {
    let live = true;
    fetchIntel(base).then((i) => { if (live) setIntel(i); }).catch(() => { if (live) setIntel(null); });
    return () => { live = false; };
  }, [base]);

  return <section className="st-price aa">
    <div className="st-price-head">
      <div>
        <h2>Bring an agent</h2>
        <p>One skill and one MCP server. The same two lines work in Bankr's agent, Grok Bot, Claude Code and Codex.</p>
      </div>
    </div>

    <div className="aa-grid">
      <div className="aa-col">
        <h3>Connect</h3>
        <CopyLine label="MCP server" value={`${base}/mcp`} />
        <CopyLine label="Skill" value={`install the skill at ${SKILL_URL}`} />
        <table className="st-table aa-tiers">
          <thead><tr><th>You present</th><th>You get</th></tr></thead>
          <tbody>
            <tr><td>No key</td><td>Every tool that reads: discover, venues, market evidence, prices, quote, preview. The execute tool is not there at all.</td></tr>
            <tr><td><code className="st-mint">X-API-Key</code></td><td>The same, plus execute — inside the owner's limits, which no key can widen.</td></tr>
          </tbody>
        </table>
        <p className="aa-foot">There is no tool that sends funds to an address. An agent that has been talked into something has nothing to call.</p>
      </div>

      <div className="aa-col">
        <h3>Buy a second opinion</h3>
        <p className="aa-lead">
          Governance is free: a refusal an agent had to pay for would be perverse. What is sold is judgement that is
          useful even for a trade executed somewhere else{intel ? `, for ${intel.instruments.filter((i) => !i.tradeable_here).map((i) => i.symbol).join(", ")} at live mainnet prices` : ""}.
        </p>
        {intel ? <table className="st-table aa-tools">
          <thead><tr><th>Tool</th><th className="num">Per call</th><th>It answers</th></tr></thead>
          <tbody>
            {intel.tools.map((tool) => <tr key={tool.id}>
              <td><code className="st-mint">{tool.id}</code></td>
              <td className="num">${tool.priceUsd}</td>
              <td>{tool.summary}</td>
            </tr>)}
          </tbody>
        </table> : <p className="st-price-note">Paid tools are not mounted on this deployment.</p>}
        {intel ? <div className="aa-rails">
          <div><span>Pay in USDC on Base</span><p>Through Bankr x402 Cloud, where any Bankr agent can find the tools in its marketplace.</p></div>
          <div><span>Pay in USDC on Solana</span><p>x402 straight to this hub, settled by PayAI. The agent needs USDC and nothing else.</p></div>
        </div> : null}
      </div>
    </div>
  </section>;
}
