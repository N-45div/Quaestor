import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import {
  ArrowRight, ArrowUpRight, Bot, Check, CircleDollarSign, Code2,
  Database, ExternalLink, FileKey2, Fingerprint, Network, OctagonX, Plug, Radio,
  Route, Scale, ShieldCheck,
} from "lucide-react";
import { explorerHref } from "../components/ExplorerShell";
import { useStore, type ReceiptView } from "../state";
import {
  agentName, CATEGORY_KEYS, CATEGORY_NAMES, native,
  shortAddr, shortHash, timeAgo,
} from "../lib/format";
import { txUrl } from "../lib/config";
import { fetchIntel, fetchMarket, stocksBase, type MarketAssessmentView } from "../lib/stocks";

const GITHUB = "https://github.com/N-45div/Quaestor";
const SKILL = `${GITHUB}/tree/main/skills/quaestor-trading`;
const SOLANA_PROGRAM = "7whSJDtnCjhjPiBeLWoyVYHemtG1BnyBVfuJuuNDtFEG";
const HUB = "https://quaestor-hub.onrender.com";

const NETWORKS = [
  { key: "xlayerTestnet", name: "X Layer", role: "Governor + live agents", unit: "OKB", tone: "xlayer" },
  { key: "arcTestnet", name: "Arc", role: "Governor · dollar caps", unit: "USDC gas", tone: "arc" },
  { key: "baseSepolia", name: "Base", role: "Governor + subgraph", unit: "ETH", tone: "base" },
  { key: "sepolia", name: "Ethereum Sepolia", role: "Attestcoin source", unit: "ETH", tone: "base" },
] as const;

const DEPLOYMENTS = [
  { chain: "X Layer testnet", id: "1952", governor: "0x7C8772fbdF1A1d9Ded219E51D3147d7C04475921", explorer: "https://www.oklink.com/xlayer-test/address/" },
  { chain: "Arc testnet", id: "5042002", governor: "0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24", explorer: "https://testnet.arcscan.app/address/" },
  { chain: "Base Sepolia", id: "84532", governor: "0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24", explorer: "https://sepolia.basescan.org/address/" },
  { chain: "Ethereum Sepolia", id: "11155111", governor: "0x34317a98d851c5b0d46e0e491be09cb956980bb3", explorer: "https://sepolia.etherscan.io/address/" },
] as const;

type PermitQuote = { permit?: { hbar?: string } };

/**
 * The price gate's current reading, fetched from the hosted hub. It is here for
 * the same reason the decision stream is in the hero: a claim about a live
 * system is better made by the system. If the hub is asleep the card says so
 * rather than showing a number from nowhere.
 */
function LiveGate() {
  const base = stocksBase();
  const [reading, setReading] = useState<{ symbol: string; market: MarketAssessmentView } | null>(null);
  const [asleep, setAsleep] = useState(false);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const traded = (await fetchIntel(base)).instruments.find((instrument) => instrument.tradeable_here);
        if (!traded) return;
        const market = await fetchMarket(base, traded.mint);
        if (live) { setReading({ symbol: traded.symbol, market }); setAsleep(false); }
      } catch {
        if (live) setAsleep(true);
      }
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => { live = false; clearInterval(timer); };
  }, [base]);

  const market = reading?.market;
  const side = market?.consensus.tokenized ?? market?.consensus.reference;
  const spread = Math.max(market?.consensus.tokenized?.spread_bps ?? 0, market?.consensus.reference?.spread_bps ?? 0);

  return (
    <div className="ql-live-card ql-gate-card">
      <div className="ql-card-bar">
        <span><i className="ql-live-dot" />Live from the price gate</span>
        <span>Solana devnet</span>
      </div>
      <div className="ql-decision-head">
        <span className="ql-decision-icon"><Scale /></span>
        <div><small>WHAT THE GATE SEES NOW</small><strong>{reading ? `${reading.symbol} · ${market?.session} session` : "Reading the evidence"}</strong></div>
        {market ? (market.allowed
          ? <span className="ql-settled"><Check />Allowed</span>
          : <span className="ql-settled ql-refused"><OctagonX />Refused</span>) : null}
      </div>
      {market && side ? <>
        <div className="ql-decision-value">${side.price.toFixed(2)}</div>
        <div className="ql-decision-meta">
          <div><span>Priced by</span><b>{side.sources.join(" + ")}</b></div>
          <div><span>They disagree by</span><b>{spread} bps · refused past {market.policy.max_source_disagreement_bps}</b></div>
          <div><span>Freshest price</span><b>{side.age_seconds}s old · dead at {market.policy.max_price_age_seconds}s</b></div>
          <div><span>A quote may sit</span><b>{market.policy.max_quote_deviation_bps} bps from this, no further</b></div>
        </div>
        <a className="ql-chain-link" href={`${explorerHref("/stocks")}?shortfall=6`}>Watch it refuse a quote the chain would accept <ArrowRight /></a>
      </> : <div className="ql-live-empty">{asleep ? "The hosted hub is waking up — free instances sleep when idle. Give it a minute." : "Connecting to the hosted hub…"}</div>}
    </div>
  );
}

const jumpTo = (id: string) => (event: MouseEvent<HTMLAnchorElement>) => {
  event.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
};

function LatestDecision({ receipt }: { receipt?: ReceiptView }) {
  const { cfg, agents } = useStore();
  const agent = receipt ? agents.find((row) => row.id === receipt.agentId) : undefined;
  const name = receipt
    ? agent ? agentName(agent.id, agent.metadataURI) : `Agent #${receipt.agentId}`
    : "Waiting for a settlement";

  return (
    <div className="ql-live-card">
      <div className="ql-card-bar">
        <span><i className="ql-live-dot" />Live decision stream</span>
        <span>{cfg?.label ?? "X Layer"}</span>
      </div>
      <div className="ql-decision-head">
        <span className="ql-decision-icon"><FileKey2 /></span>
        <div><small>LATEST GOVERNED DECISION</small><strong>{name}</strong></div>
        <span className="ql-settled"><Check />Settled</span>
      </div>
      {receipt ? <>
        <div className="ql-decision-value">{native(receipt.amount, cfg?.symbol, 6)}</div>
        <div className="ql-decision-meta">
          <a href={explorerHref(`/decisions/${receipt.metaHash}`, cfg?.network)}>
            <span>Decision</span><b>{shortHash(receipt.metaHash)}</b><ArrowRight />
          </a>
          <div><span>Purpose</span><b className={`ql-purpose ql-purpose-${CATEGORY_KEYS[receipt.category]}`}>{CATEGORY_NAMES[receipt.category]}</b></div>
          <div><span>Payee</span><b>{shortAddr(receipt.payee)}</b></div>
          <div><span>Observed</span><b>{timeAgo(receipt.timestamp)}</b></div>
        </div>
        {cfg && txUrl(cfg, receipt.txHash) ? <a className="ql-chain-link" href={txUrl(cfg, receipt.txHash)!} target="_blank" rel="noreferrer">Open transaction on the chain <ArrowUpRight /></a> : null}
      </> : <div className="ql-live-empty">Connecting to the public indexer…</div>}
    </div>
  );
}

export function Landing() {
  const { cfg, ready, agents, receipts, receiptStatus } = useStore();
  const [quote, setQuote] = useState<PermitQuote | null>(null);
  const latest = receipts[0];
  const activeAgents = agents.filter((agent) => !agent.suspended).length;
  const recent = receipts.filter((receipt) => receipt.timestamp > Date.now() - 86_400_000);
  const observedAgents = useMemo(() => new Set(receipts.map((receipt) => receipt.agentId.toString())).size, [receipts]);

  useEffect(() => {
    let stopped = false;
    const base = cfg?.decisionLedgerUrl || HUB;
    fetch(`${base}/v1/risk/quote?venue=quaestor-dex`, { signal: AbortSignal.timeout(10_000) })
      .then((response) => response.ok ? response.json() : null)
      .then((body) => { if (!stopped) setQuote(body); })
      .catch(() => undefined);
    return () => { stopped = true; };
  }, [cfg?.decisionLedgerUrl]);

  return (
    <div className="ql">
      <header className="ql-header">
        <a className="ql-wordmark" href="#/" aria-label="Quaestor home">QU<span>Æ</span>STOR</a>
        <nav aria-label="Landing navigation">
          <a href="#product" onClick={jumpTo("product")}>Product</a><a href="#stocks" onClick={jumpTo("stocks")}>Stocks</a><a href="#how" onClick={jumpTo("how")}>How it works</a><a href="#networks" onClick={jumpTo("networks")}>Networks</a>
          <a href={GITHUB} target="_blank" rel="noreferrer">Source <ExternalLink /></a>
        </nav>
        <a className="ql-nav-cta" href={explorerHref("/", "xlayerTestnet")}>Open explorer <ArrowRight /></a>
      </header>

      <main>
        <section className="ql-hero">
          <div className="ql-hero-copy">
            <div className="ql-kicker"><Radio />Live on Solana and four EVM networks</div>
            <h1>The routing layer for agents that move money.</h1>
            <p>Quaestor gives trading agents one place to price venue risk, check owner-set budgets, settle paid decisions, and leave a public record anyone can inspect.</p>
            <div className="ql-actions">
              <a className="ql-button ql-button-primary" href={explorerHref("/", "xlayerTestnet")}>Explore live activity <ArrowRight /></a>
              <a className="ql-button ql-button-secondary" href={explorerHref("/stocks")}><Scale />Watch the price gate decide</a>
            </div>
            <div className="ql-public-note"><ShieldCheck />Public reads are open. A wallet appears only when an owner manages an agent.</div>
          </div>
          <LatestDecision receipt={latest} />
        </section>

        <section className="ql-proof" aria-label="Live Quaestor proof">
          <div><strong>{ready ? agents.length : "—"}</strong><span>agents on X Layer</span><small>{ready ? `${activeAgents} able to spend` : "reading chain state"}</small></div>
          <div><strong>{receipts.length || "—"}</strong><span>indexed decisions</span><small>{recent.length} in the last 24h</small></div>
          <div><strong>6</strong><span>public agent routes</span><small>risk · policy · execution</small></div>
          <div><strong>5 + 3</strong><span>governors + payment rails</span><small>Solana · X Layer · Arc · Base · Sepolia</small></div>
        </section>

        <section className="ql-section ql-product" id="product">
          <div className="ql-section-heading">
            <span className="ql-kicker">ONE SYSTEM, TWO SURFACES</span>
            <h2>A route engine underneath.<br />A public record on top.</h2>
            <p>Agents get machine-readable decisions. Humans get an explorer built from the same evidence.</p>
          </div>
          <div className="ql-product-grid">
            <article className="ql-product-card ql-router-card">
              <div className="ql-product-title"><span><Route /></span><div><small>FOR AGENTS</small><h3>Decision routing</h3></div></div>
              <p>Discover a route, preview its exact price, check budget policy, then settle through x402.</p>
              <div className="ql-route-list">
                <div><span>01</span><b>Venue risk permit</b><small>{quote?.permit?.hbar ? `${quote.permit.hbar} HBAR now` : "live quote loading"}</small></div>
                <div><span>02</span><b>Budget evaluation</b><small>7 policy checks</small></div>
                <div><span>03</span><b>Execution quote</b><small>priced per venue</small></div>
              </div>
              <a href={explorerHref("/routes", "xlayerTestnet")}>Open the live route catalog <ArrowRight /></a>
            </article>

            <article className="ql-product-card ql-explorer-card">
              <div className="ql-product-title"><span><Database /></span><div><small>FOR EVERYONE</small><h3>Agent explorer</h3></div></div>
              <p>Trace an agent from authority and limits to the reason behind every settled payment.</p>
              <div className="ql-mini-table">
                <div className="ql-mini-head"><span>Agent</span><span>Purpose</span><span>Value</span><span>Age</span></div>
                {receipts.slice(0, 4).map((receipt) => {
                  const agent = agents.find((row) => row.id === receipt.agentId);
                  return <a key={`${receipt.txHash}-${receipt.metaHash}`} href={explorerHref(`/decisions/${receipt.metaHash}`, cfg?.network)}>
                    <span>{agent ? agentName(agent.id, agent.metadataURI) : `Agent #${receipt.agentId}`}</span>
                    <span className={`ql-purpose ql-purpose-${CATEGORY_KEYS[receipt.category]}`}>{CATEGORY_NAMES[receipt.category]}</span>
                    <span>{native(receipt.amount, cfg?.symbol, 5)}</span><span>{timeAgo(receipt.timestamp)}</span>
                  </a>;
                })}
                {!receipts.length ? <div className="ql-mini-empty">Reading the latest on-chain activity…</div> : null}
              </div>
              <a href={explorerHref("/decisions", "xlayerTestnet")}>Browse every indexed decision <ArrowRight /></a>
            </article>
          </div>
        </section>

        <section className="ql-section ql-stocks" id="stocks">
          <div className="ql-section-heading ql-section-heading-row">
            <div><span className="ql-kicker">TOKENIZED STOCKS ON SOLANA</span><h2>The chain checks the money.<br />The gate checks the price.</h2></div>
            <p>An agent trading tokenized stocks never holds the funds. A Solana program does, and it refuses anything outside the owner&rsquo;s limits. Before that, a price gate refuses quotes the market does not support.</p>
          </div>
          <div className="ql-stocks-grid">
            <LiveGate />
            <div className="ql-caps">
              <article><ShieldCheck /><small>On-chain</small><h3>A governor that cannot be argued with</h3><p>Per-trade and daily caps, an allowlist of instruments and of venues, and a balance check after every swap. The agent&rsquo;s key can do one thing: a governed trade. Only the owner can withdraw, so an agent that has been talked into something has nothing to call.</p></article>
              <article><Scale /><small>Before signing</small><h3>A price gate that fails closed</h3><p>The chain enforces the floor a quote guarantees, and the floor comes from the quote. So that floor is measured against two independent sources. Missing, stale or disagreeing prices refuse the trade.</p></article>
              <article><Plug /><small>For agents</small><h3>One skill, one MCP server</h3><p>Bankr&rsquo;s agent, Grok Bot, Claude Code and Codex install the same two lines. With no key an agent reads and quotes; trading takes the owner&rsquo;s key, inside limits no key can widen.</p></article>
              <article><CircleDollarSign /><small>Pay per call</small><h3>Judgement, sold separately</h3><p>&ldquo;Is this quote fair?&rdquo; for a quote from any venue, on live mainnet prices, from $0.001. USDC on Base through Bankr x402 Cloud, or on Solana through PayAI. Governance itself stays free.</p></article>
            </div>
          </div>
          <div className="ql-actions ql-stocks-actions">
            <a className="ql-button ql-button-primary" href={explorerHref("/stocks")}>Open the Stocks view <ArrowRight /></a>
            <a className="ql-button ql-button-secondary" href={SKILL} target="_blank" rel="noreferrer"><Bot />Read the agent skill</a>
          </div>
        </section>

        <section className="ql-section ql-flow" id="how">
          <div className="ql-section-heading ql-section-heading-row">
            <div><span className="ql-kicker">FROM INTENT TO EVIDENCE</span><h2>Four steps. One inspectable trail.</h2></div>
            <p>The agent can move quickly because the owner’s boundaries are already encoded.</p>
          </div>
          <div className="ql-flow-grid">
            <article><span>01</span><Bot /><h3>Agent asks</h3><p>A trading agent requests risk, policy, data or execution.</p></article>
            <article><span>02</span><Route /><h3>Quaestor routes</h3><p>The hub exposes the decision and exact machine price before payment.</p></article>
            <article><span>03</span><ShieldCheck /><h3>Governor checks</h3><p>Per-call and per-epoch caps execute on-chain. Excess spend reverts.</p></article>
            <article><span>04</span><Fingerprint /><h3>Receipt proves</h3><p>The payment binds to a decision hash that anyone can verify.</p></article>
          </div>
        </section>

        <section className="ql-section ql-networks" id="networks">
          <div className="ql-section-heading ql-section-heading-row">
            <div><span className="ql-kicker">MULTICHAIN BY DESIGN</span><h2>One explorer. Native rules on every chain.</h2></div>
            <p>Quaestor keeps the product model consistent while the unit, explorer, and data source change by network.</p>
          </div>
          <div className="ql-network-grid">
            <a href={explorerHref("/stocks")} className="ql-network ql-network-solana">
              <div><i /><span>Solana</span><ArrowUpRight /></div><strong>Stock governor + price gate</strong><small>USDC · devnet</small>
            </a>
            {NETWORKS.map((network) => <a key={network.key} href={explorerHref("/", network.key)} className={`ql-network ql-network-${network.tone}`}>
              <div><i /><span>{network.name}</span><ArrowUpRight /></div><strong>{network.role}</strong><small>{network.unit}</small>
            </a>)}
            <article className="ql-network ql-network-hedera"><div><i /><span>Hedera</span><CircleDollarSign /></div><strong>x402 settlement rail</strong><small>HBAR</small></article>
          </div>

          <div className="ql-ledger-wrap">
            <div className="ql-ledger-title"><span><Network />Verified deployments</span><small>Full addresses from deployment artifacts</small></div>
            <div className="ql-ledger-scroll"><table className="ql-ledger">
              <thead><tr><th>Network</th><th>Chain ID</th><th>Governor</th><th>Proof</th></tr></thead>
              <tbody>
                <tr><td>Solana devnet</td><td>devnet</td><td>{SOLANA_PROGRAM} <span className="ql-muted">program</span></td><td><a href={`https://explorer.solana.com/address/${SOLANA_PROGRAM}?cluster=devnet`} target="_blank" rel="noreferrer">Explorer <ArrowUpRight /></a></td></tr>
                {DEPLOYMENTS.map((row) => <tr key={row.chain}><td>{row.chain}</td><td>{row.id}</td><td>{row.governor}</td><td><a href={`${row.explorer}${row.governor}`} target="_blank" rel="noreferrer">Explorer <ArrowUpRight /></a></td></tr>)}
                <tr><td>Hedera testnet</td><td>296</td><td className="ql-muted">Settlement only</td><td><span className="ql-settlement-chip">x402</span></td></tr>
                <tr><td>Creditcoin testnet</td><td>102031</td><td>0x2e91d035D622d2ECa36B7836CBcf9651711B2D10 <span className="ql-muted">budget root</span></td><td><a href="https://creditcoin-testnet.blockscout.com/address/0x2e91d035D622d2ECa36B7836CBcf9651711B2D10" target="_blank" rel="noreferrer">Explorer <ArrowUpRight /></a></td></tr>
              </tbody>
            </table></div>
          </div>
        </section>

        <section className="ql-section ql-evidence">
          <div className="ql-evidence-copy">
            <span className="ql-kicker">BUILT TO BE CHECKED</span><h2>Every claim resolves to evidence.</h2>
            <p>The public explorer reads chain state and indexed events. Decision records re-hash in the browser. Contract source, deployment addresses, and the current enforcement boundary stay visible.</p>
            <div className="ql-actions"><a className="ql-button ql-button-primary" href={explorerHref("/decisions", "xlayerTestnet")}>Inspect decisions <ArrowRight /></a><a className="ql-button ql-button-secondary" href={GITHUB} target="_blank" rel="noreferrer"><Code2 />Read the source</a></div>
          </div>
          <div className="ql-evidence-list">
            <div><Check /><span><b>On-chain budgets</b>Per-call and per-epoch caps enforced by each governor.</span></div>
            <div><Check /><span><b>Reason-bound receipts</b>Decision hashes travel with the payment event.</span></div>
            <div><Check /><span><b>Fail-closed policy</b>History-dependent checks refuse when their index is stale.</span></div>
            <div><Check /><span><b>Measured, not trusted</b>On Solana the program measures the vault and the position after every swap, and reverts on a shortfall.</span></div>
            <div><Check /><span><b>Honest boundary</b>The stock lane runs on devnet, where the asset is a test mint priced from the live market. On the EVM governors, venue permits are observable today; mandatory execution verification is the next contract version.</span></div>
          </div>
        </section>

        <section className="ql-final"><div><span className="ql-kicker">THE PUBLIC RECORD IS LIVE</span><h2>Follow the money. Read the reason.</h2></div><a className="ql-button ql-button-primary" href={explorerHref("/", "xlayerTestnet")}>Open the agent explorer <ArrowRight /></a></section>
      </main>

      <footer className="ql-footer">
        <a className="ql-wordmark" href="#/">QU<span>Æ</span>STOR</a><p>One governed endpoint for trading agents.</p>
        <div><span>{observedAgents} agents observed in indexed history</span><span>{receiptStatus.complete ? "History indexed" : "Indexer filling history"}</span><a href={GITHUB} target="_blank" rel="noreferrer">GitHub <ArrowUpRight /></a></div>
      </footer>
    </div>
  );
}
