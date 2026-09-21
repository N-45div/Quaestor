import { ArrowLeft, KeyRound, ShieldCheck, Terminal, Wallet } from "lucide-react";
import { explorerHref } from "../components/ExplorerShell";
import { AGENT_CLI_URL, AGENT_SKILL_URL, RegisterAgent } from "../components/RegisterAgent";
import { useStore } from "../state";
import { WalletButton } from "../components/WalletButton";
import { shortAddr } from "../lib/format";

/**
 * Bring your own agent. The agent makes its own operator key and sends its
 * owner here with that key's address in the link; the owner registers it from
 * their own wallet, funds it and caps it. Nobody else holds either key, and
 * this page never sees the operator's.
 */
export function RegisterView() {
  const { cfg, account } = useStore();
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const operator = params.get("operator") ?? undefined;
  const symbol = cfg?.symbol ?? "ETH";

  return <>
    <section className="page-intro compact"><div>
      <a className="back-link" href={explorerHref("/agents", cfg?.network)}><ArrowLeft size={13}/>All agents</a>
      <span className="eyebrow">BRING YOUR AGENT</span>
      <h1>Register an agent</h1>
      <p>Your agent trades from a treasury you fund, inside caps you set, through the venues you allow, and whatever it buys lands in your wallet. Beyond that its key can only pay for data or inference, up to the separate caps you set for those. You can suspend it or withdraw at any time.</p>
    </div></section>

    <section className="onboard-steps" aria-label="How it works">
      <article><span>01</span><KeyRound size={18}/><h3>Your agent makes its key</h3><p>It downloads <a href={AGENT_CLI_URL} target="_blank" rel="noreferrer">one file</a> and runs <code>node quaestor.mjs keygen</code>. It keeps the key and sends you a link to this page with its address filled in.</p></article>
      <article><span>02</span><Wallet size={18}/><h3>You sign it here</h3><p>From your own wallet, any wallet: a deposit, three caps, and Uniswap and USDC allowed. One signature if your wallet can batch, otherwise one per step.</p></article>
      <article><span>03</span><Terminal size={18}/><h3>It trades under your limits</h3><p>It runs <code>buy</code> with a reason, following <a href={AGENT_SKILL_URL} target="_blank" rel="noreferrer">the skill</a>. A trade outside your limits is refused on chain.</p></article>
    </section>

    <section className="manage-area register-area">
      <div className="manage-notice">
        <ShieldCheck size={22}/>
        <div>
          <h2>{cfg?.mainnet ? `Real ${symbol} on ${cfg?.label ?? "mainnet"}` : "Owner wallet"}</h2>
          <p>{cfg?.mainnet
            ? "The contracts are unaudited. Start with a small deposit; the defaults below allow a few small trades a day."
            : "Registering needs a wallet. Browsing never does."}</p>
        </div>
        {!account
          ? <WalletButton />
          : <span className="state-badge live">Connected {shortAddr(account)}</span>}
      </div>
      {/* The form takes its starting values from the chain's config when it mounts,
          so it waits for the config: rendered earlier it would start from the
          testnet defaults, a 0.1 ETH deposit, on mainnet. */}
      {cfg
        ? <RegisterAgent key={cfg.network} initialOperator={operator} onDone={() => { window.location.hash = explorerHref("/agents", cfg.network); }}/>
        : <div className="form-card"><p className="success-sub">Reading the network…</p></div>}
    </section>
  </>;
}
