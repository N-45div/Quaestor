import { useEffect, useState } from "react";
import { ArrowLeft, Droplets, KeyRound, ShieldCheck, Terminal, Wallet } from "lucide-react";
import { PublicKey } from "@solana/web3.js";
import { explorerHref } from "../../components/ExplorerShell";
import { stocksBase } from "../../lib/stocks";
import { explainSolanaError, parseUsdc } from "../../lib/solana/errors";
import { buildRegisterTransaction, existingGovernor, ownerFunds } from "../../lib/solana/register";
import { useSolana } from "../../lib/solana/store";
import { KeyLink, usdc } from "./common";
import { SolanaWalletButton } from "./SolanaWalletButton";

export const SOL_CLI_URL = "https://gitlab.com/ndivij2004/quaestor/-/raw/main/cli/dist/quaestor-sol.mjs";
export const SOL_SKILL_URL = "https://gitlab.com/ndivij2004/quaestor/-/tree/main/skills/quaestor-solana";
const EPOCHS = [{ label: "1 hour", value: 3600 }, { label: "1 day", value: 86_400 }, { label: "1 week", value: 604_800 }];
const MIN_LAMPORTS = 10_000_000; // rent for five accounts and the fee, with room to spare

/**
 * Open a governor of one's own on devnet: the owner's wallet signs one
 * transaction, and the agent's key can then trade inside its caps. The agent
 * makes that key itself and sends the link to this page with it filled in.
 */
export function SolanaRegister() {
  const { conn, account, send } = useSolana();
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const linked = params.get("operator") ?? "";
  const [operator, setOperator] = useState(linked);
  const [confirmed, setConfirmed] = useState(false);
  const [deposit, setDeposit] = useState(params.get("deposit") ?? "50");
  const [perTrade, setPerTrade] = useState(params.get("perTrade") ?? "5");
  const [epochCap, setEpochCap] = useState(params.get("epochCap") ?? "25");
  const [epoch, setEpoch] = useState(EPOCHS.some((e) => String(e.value) === params.get("epoch")) ? Number(params.get("epoch")) : 86_400);
  const [funds, setFunds] = useState<{ usdc: bigint; lamports: number } | null>(null);
  const [existing, setExisting] = useState<PublicKey | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ governor: string; signature: string } | null>(null);
  const fromLink = Boolean(linked) && operator === linked;

  const reload = async () => {
    if (!account) return null;
    const owner = new PublicKey(account.address);
    const [f, g] = await Promise.all([ownerFunds(conn, owner), existingGovernor(conn, owner)]);
    setFunds(f);
    setExisting(g);
    return f;
  };
  useEffect(() => { setFunds(null); setExisting(null); void reload().catch(() => undefined); }, [account?.address]);

  const claim = async () => {
    if (!account) return;
    setErr(null);
    setBusy("Asking the faucet…");
    try {
      const res = await fetch(`${stocksBase()}/v1/stocks/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: account.address }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `the faucet answered ${res.status}`);
      // The transfer has settled, but a public node can answer from a slot
      // before it for a few seconds; read until the money shows.
      const before = funds?.usdc ?? 0n;
      for (let i = 0; i < 12; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        const f = await reload();
        if (f && f.usdc > before) break;
      }
    } catch (e) {
      setErr(`Faucet: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  /** Everything that can be wrong, found before the wallet is asked to sign. */
  const problem = (): string | null => {
    if (!account || !funds) return "Connect the owner's Solana wallet first.";
    let op: PublicKey;
    try { op = new PublicKey(operator.trim()); } catch { return "The agent key must be a Solana address: the one your agent's keygen printed."; }
    if (!PublicKey.isOnCurve(op.toBytes())) return "The agent key must be a wallet key, not a program address.";
    if (op.toBase58() === account.address) return "The agent key must not be your own wallet: it would then also be the key that withdraws.";
    if (fromLink && !confirmed) return "Confirm that the agent key is the one your own agent printed.";
    const dep = parseUsdc(deposit), per = parseUsdc(perTrade), cap = parseUsdc(epochCap);
    if (dep === null || per === null || cap === null) return "Write amounts like 50 or 2.5, with no commas or units.";
    if (per === 0n) return "The per-trade cap must be above zero.";
    if (per > cap) return "The per-trade cap is larger than the epoch cap.";
    if (dep > funds.usdc) return `The deposit is more than the ${usdc(funds.usdc)} test USDC this wallet holds.`;
    if (funds.lamports < MIN_LAMPORTS) return "The wallet needs about 0.01 SOL for the accounts this creates.";
    return null;
  };

  const register = async () => {
    setErr(null);
    const why = problem();
    if (why) return setErr(why);
    setBusy("Waiting for the wallet…");
    try {
      const { transaction, vault, governor } = buildRegisterTransaction({
        owner: new PublicKey(account!.address),
        operator: new PublicKey(operator.trim()),
        deposit: parseUsdc(deposit)!,
        perTradeCap: parseUsdc(perTrade)!,
        epochCap: parseUsdc(epochCap)!,
        epochSeconds: BigInt(epoch),
      });
      const signature = await send(transaction, [vault]);
      setDone({ governor: governor.toBase58(), signature });
    } catch (e) {
      setErr(explainSolanaError(e));
    } finally {
      setBusy(null);
    }
  };

  const agentCommands = [
    `curl -fsSLO ${SOL_CLI_URL}`,
    "node quaestor-sol.mjs status",
    'node quaestor-sol.mjs buy --usdc 1 --reason "<why this trade>" --dry-run',
  ].join("\n");

  return <>
    <section className="page-intro compact"><div>
      <a className="back-link" href={explorerHref("/sol/agents")}><ArrowLeft size={13} />All agents</a>
      <span className="eyebrow">BRING YOUR AGENT · SOLANA DEVNET</span>
      <h1>Register an agent</h1>
      <p>Your wallet opens a governor of its own: a vault you fund, caps you set, and one agent key that can trade inside them and do nothing else. It buys on the Meteora curve, and the program checks every trade against your caps and the floor.</p>
    </div></section>

    <section className="onboard-steps" aria-label="How it works">
      <article><span>01</span><KeyRound size={18} /><h3>Your agent makes its key</h3><p>It downloads <a href={SOL_CLI_URL} target="_blank" rel="noreferrer">one file</a>, runs <code>keygen</code> and keeps the key, then <code>register</code>. It sends you a link to this page with its key filled in.</p></article>
      <article><span>02</span><Wallet size={18} /><h3>You sign it here</h3><p>Any Solana wallet, on devnet. One signature creates the governor, allows the curve, opens the account bought tokens land in and deposits your test USDC.</p></article>
      <article><span>03</span><Terminal size={18} /><h3>It trades under your caps</h3><p>It runs <code>buy</code> with a reason, following <a href={SOL_SKILL_URL} target="_blank" rel="noreferrer">the skill</a>. A trade outside your caps, or below the floor, is refused on chain.</p></article>
    </section>

    <section className="manage-area register-area">
      <div className="manage-notice">
        <ShieldCheck size={22} />
        <div><h2>Devnet, test money</h2><p>Test USDC from the faucet, no real value. One wallet owns one governor. Bought tokens stay in the governor&rsquo;s account: the program has no instruction that sells them or moves them out yet.</p></div>
        <SolanaWalletButton onError={setErr} />
      </div>

      {done ? (
        <div className="form-card">
          <div className="success-head">✓ Your governor is open on devnet.</div>
          <p className="success-sub">Its agent can trade within the caps you set. Hand it these commands, or the skill. The agent pays its own fees, so send its key a little devnet SOL.</p>
          <pre className="env-block">{agentCommands}</pre>
          <div className="form-actions">
            <a className="btn btn-gold btn-sm" href={explorerHref(`/sol/agents/${done.governor}`)}>Open your governor</a>
            <KeyLink value={done.signature} kind="tx" />
          </div>
        </div>
      ) : existing ? (
        <div className="form-card">
          <div className="success-head" style={{ color: "var(--gold)" }}>This wallet already has a governor.</div>
          <p className="success-sub">Each wallet can own one. Open it to see its caps, its vault and its trades, or connect another wallet to register another agent.</p>
          <div className="form-actions"><a className="btn btn-gold btn-sm" href={explorerHref(`/sol/agents/${existing.toBase58()}`)}>Open it</a></div>
        </div>
      ) : (
        <div className="form-card">
          {account && funds ? (
            <p className="link-proposed">
              This wallet holds {usdc(funds.usdc)} test USDC and {(funds.lamports / 1e9).toFixed(4)} SOL.{" "}
              {funds.usdc < (parseUsdc(deposit) ?? 0n) || funds.lamports < MIN_LAMPORTS
                ? <button className="btn btn-ghost btn-sm" onClick={() => void claim()} disabled={Boolean(busy)}><Droplets size={14} />Get 100 test USDC and some SOL</button>
                : null}
            </p>
          ) : null}
          <div className="form-grid">
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label htmlFor="sol-operator">Agent key</label>
              <input id="sol-operator" value={operator} onChange={(e) => setOperator(e.target.value.trim())} placeholder="the address your agent's keygen printed" />
              {fromLink ? (
                <label className="note link-confirm">
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                  <span>Filled in from a link. Whoever holds this key can spend up to your caps every epoch. It is the key my own agent printed (<code>node quaestor-sol.mjs whoami</code>).</span>
                </label>
              ) : <div className="note">The agent&rsquo;s key can only trade, inside the caps below. It cannot withdraw or change anything.</div>}
            </div>
            <div className="field"><label htmlFor="sol-deposit">Deposit (test USDC)</label><input id="sol-deposit" value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" /></div>
            <div className="field"><label htmlFor="sol-epoch">Epoch</label><select id="sol-epoch" value={epoch} onChange={(e) => setEpoch(Number(e.target.value))}>{EPOCHS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}</select></div>
            <div className="field"><label htmlFor="sol-per-trade">Per-trade cap (USDC)</label><input id="sol-per-trade" value={perTrade} onChange={(e) => setPerTrade(e.target.value)} inputMode="decimal" /></div>
            <div className="field"><label htmlFor="sol-epoch-cap">Epoch cap (USDC)</label><input id="sol-epoch-cap" value={epochCap} onChange={(e) => setEpochCap(e.target.value)} inputMode="decimal" /></div>
          </div>
          <div className="form-actions">
            <button className="btn btn-gold" onClick={() => void register()} disabled={Boolean(busy) || !account}>{busy ?? "Open the governor"}</button>
            {err ? <span className="form-msg err">{err}</span> : !account ? <span className="form-msg">Connect a Solana wallet to register.</span> : null}
          </div>
        </div>
      )}
    </section>
  </>;
}
