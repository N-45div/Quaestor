import { useEffect, useState } from "react";
import { ExternalLink, KeyRound, Lock } from "lucide-react";
import {
  fetchPortfolio,
  shortMint,
  solanaExplorer,
  stocksAgentId,
  usdc,
  type DiscoveryView,
  type PortfolioView,
} from "../lib/stocks";

const dollars = (value: number): string => `$${value.toFixed(value >= 100 ? 0 : 2)}`;

/**
 * The owner's policy and what the agent has done inside it.
 *
 * The limits come from the hub's discovery document and the spend from its
 * running ledger — a mirror of the chain, which restarts with the service. So
 * the panel ends with the addresses: the program, the governor and the vault
 * are public, and anyone can check this page against what the chain recorded.
 */
export function GovernorPanel({ base, discovery, decimals }: { base: string; discovery: DiscoveryView; decimals: Record<string, number> }) {
  const [portfolio, setPortfolio] = useState<PortfolioView | null>(null);
  const limits = discovery.limits;
  const onchain = discovery.onchain;

  useEffect(() => {
    let live = true;
    const load = () => fetchPortfolio(base, stocksAgentId())
      .then((p) => { if (live) setPortfolio(p); })
      .catch(() => { if (live) setPortfolio(null); });
    void load();
    const timer = setInterval(load, 30_000);
    return () => { live = false; clearInterval(timer); };
  }, [base]);

  if (!limits) return null;
  const cap = usdc(limits.epoch_cap_usdc);
  const spent = usdc(portfolio?.policy.spent_usdc);
  const pending = usdc(portfolio?.policy.pending_usdc);
  const used = cap > 0 ? Math.min(1, (spent + pending) / cap) : 0;
  const hours = Math.round(limits.epoch_length_seconds / 3_600);

  return <section className="st-price gp">
    <div className="st-price-head">
      <div>
        <h2>What the owner allows</h2>
        <p>The hub holds its agent to these before it signs, and the program enforces the governor&rsquo;s own caps on {discovery.network} on every trade{onchain ? <> (<a href={`#/app/sol/agents/${onchain.governor}`}>see the governor</a>)</> : null}. The agent can read these limits; it cannot change them.</p>
      </div>
      {portfolio?.policy.suspended
        ? <span className="pg-verdict pg-verdict-no"><Lock size={15} />Paused by the owner</span>
        : null}
    </div>

    <div className="st-tiles gp-tiles">
      <div><span>Per trade</span><strong>{dollars(usdc(limits.per_trade_cap_usdc))}</strong><small>at most, and at least {dollars(usdc(limits.min_trade_usdc))}</small></div>
      <div><span>Per {hours === 24 ? "day" : `${hours}h`}</span><strong>{dollars(cap)}</strong><small>{limits.max_executions_per_day} executions a day at most</small></div>
      <div><span>Venues approved</span><strong>{limits.approved_venues.length}</strong><small>{limits.approved_venues.join(", ")}</small></div>
    </div>

    <div className="gp-spend">
      <div className="gp-spend-head">
        <span>Spent this period</span>
        <strong>{dollars(spent)}{pending > 0 ? ` + ${dollars(pending)} in flight` : ""} <small>of {dollars(cap)}</small></strong>
      </div>
      <div className="gp-bar" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={spent + pending}
        aria-label={`${dollars(spent + pending)} of the ${dollars(cap)} allowance used`}>
        <div className="gp-bar-fill" style={{ width: `${used * 100}%` }} />
      </div>
      <p>
        {portfolio
          ? <>{portfolio.holdings.length > 0
              ? <>It holds {portfolio.holdings.map((h) => `${(Number(h.amount) / 10 ** (decimals[h.mint] ?? 8)).toFixed(4)} ${h.symbol}`).join(", ")}.</>
              : "It holds nothing yet."}</>
          : "Reading the hub's ledger."}{" "}
        The hub reads its spend and holdings back from the chain at boot and every few minutes after; the accounts below are the chain's own record.
      </p>
    </div>

    {onchain?.operator_custody === "dynamic-mpc" ? <div className="gp-custody">
      <KeyRound size={16} aria-hidden="true" />
      <p>
        <strong>The key that signs trades is split.</strong> The operator is a two-of-two MPC wallet with Dynamic:
        this hub holds one share, Dynamic holds the other, and a signature takes both. The hub does not hold the
        whole key, and the owner can cut this hub off by revoking one token at Dynamic.
        It changes who can sign, not what a signature can do: the limits above bind it either way.
      </p>
    </div> : null}

    {onchain ? <div className="gp-links">
      {([["Program", onchain.program], ["Governor", onchain.governor], ["Vault", onchain.vault], ["Operator", onchain.operator]] as const).map(([label, address]) =>
        <a key={label} href={solanaExplorer("address", address, onchain.cluster)} target="_blank" rel="noreferrer">
          <span>{label}</span><code className="st-mint">{shortMint(address)}</code><ExternalLink size={13} />
        </a>)}
    </div> : null}
  </section>;
}
