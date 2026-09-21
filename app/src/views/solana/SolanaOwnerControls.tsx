import { useEffect, useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { ShieldCheck } from "lucide-react";
import { DEVNET } from "../../lib/solana/devnet";
import { depositUsdc, setOperator, setPolicy, setSuspended, withdrawUsdc } from "../../lib/solana/program";
import { TOKEN_PROGRAM_ID, associatedTokenAddress, createAssociatedTokenAccountIdempotent, ownerFunds } from "../../lib/solana/register";
import { explainSolanaError, parseUsdc } from "../../lib/solana/errors";
import { shortKey, units, type GovernorView } from "../../lib/solana/chain";
import { useSolana } from "../../lib/solana/store";
import { KeyLink, usdc } from "./common";
import { SolanaWalletButton } from "./SolanaWalletButton";

type Outcome = { ok: true; text: string; signature: string } | { ok: false; text: string } | null;

/** An amount as a person would type it back: no thousands separators. */
const typed = (amount: bigint) => units(amount, DEVNET.usdcDecimals).replace(/,/g, "");

function amountOf(text: string, what: string): bigint {
  const amount = parseUsdc(text);
  if (amount === null) throw new Error(`Enter the ${what} as a test USDC amount, such as 5 or 2.5.`);
  if (amount === 0n) throw new Error(`The ${what} must be above zero.`);
  return amount;
}

/**
 * What only the owner may do to a governor, from the owner's own wallet:
 * change the caps, suspend or resume the agent, replace its key, and move
 * test USDC in and out of the vault. The program checks that the owner signed
 * every one of these; the page only keeps the forms from anyone else.
 */
export function SolanaOwnerControls({ g }: { g: GovernorView }) {
  const { conn, account, send } = useSolana();
  const owner = g.owner.toBase58();
  const isOwner = account?.address === owner;
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [wallet, setWallet] = useState<bigint | null>(null);
  const [perTrade, setPerTrade] = useState(typed(g.perTradeCap));
  const [epochCap, setEpochCap] = useState(typed(g.epochCap));
  const [amount, setAmount] = useState("");
  const [operator, setOperatorText] = useState("");

  const readWallet = () => ownerFunds(conn, g.owner).then((f) => setWallet(f.usdc)).catch(() => setWallet(null));
  useEffect(() => { if (isOwner) void readWallet(); }, [isOwner, conn, owner]);

  const run = async (name: string, build: () => Transaction, done: string) => {
    setBusy(name);
    setOutcome(null);
    try {
      const signature = await send(build());
      setOutcome({ ok: true, text: done, signature });
      void readWallet();
    } catch (e) {
      setOutcome({ ok: false, text: explainSolanaError(e) });
    } finally {
      setBusy(null);
    }
  };
  const label = (name: string, idle: string) => (busy === name ? "Waiting for the wallet…" : idle);

  if (!isOwner) {
    return <section className="policy-section">
      <div className="section-heading"><div><span className="eyebrow">OWNER CONTROLS</span><h2>Change what the agent may do</h2></div></div>
      <div className="manage-notice"><ShieldCheck size={22} /><div>
        <h2>{account ? "This wallet is not the owner" : "Only the owner can change this governor"}</h2>
        <p>{account
          ? `The connected wallet ${shortKey(account.address)} does not own this governor; ${shortKey(owner)} does. The program refuses any change the owner did not sign.`
          : `Connect the wallet that owns it (${shortKey(owner)}) to change the caps, suspend the agent, replace its key, or move test USDC in and out of the vault.`}</p>
      </div><SolanaWalletButton onError={(text) => setOutcome({ ok: false, text })} /></div>
      {outcome && !outcome.ok && <p className="form-msg err">{outcome.text}</p>}
    </section>;
  }

  const usdcMint = new PublicKey(DEVNET.usdcMint);
  const ownerUsdc = associatedTokenAddress(g.owner, usdcMint);

  return <section className="policy-section">
    <div className="section-heading"><div><span className="eyebrow">OWNER CONTROLS</span><h2>Change what the agent may do</h2></div><SolanaWalletButton onError={(text) => setOutcome({ ok: false, text })} /></div>
    <div className="owner-grid">
      <article>
        <h3>Caps</h3>
        <p className="muted-copy">The most one trade may take from the vault, and the most all trades may take in one epoch.</p>
        <div className="owner-fields">
          <div className="field"><label htmlFor="own-per-trade">Per trade (USDC)</label><input id="own-per-trade" inputMode="decimal" value={perTrade} onChange={(e) => setPerTrade(e.target.value)} /></div>
          <div className="field"><label htmlFor="own-epoch-cap">Per epoch (USDC)</label><input id="own-epoch-cap" inputMode="decimal" value={epochCap} onChange={(e) => setEpochCap(e.target.value)} /></div>
        </div>
        <button className="btn btn-gold btn-sm" disabled={Boolean(busy)} onClick={() => void run("caps", () => {
          const p = amountOf(perTrade, "per-trade cap");
          const e = amountOf(epochCap, "epoch cap");
          if (p > e) throw new Error("The per-trade cap cannot be above the epoch cap.");
          return new Transaction().add(setPolicy(g.owner, e, p));
        }, `Caps set: ${perTrade} USDC a trade, ${epochCap} USDC an epoch.`)}>{label("caps", "Set the caps")}</button>
      </article>

      <article>
        <h3>{g.suspended ? "Suspended" : "Trading"}</h3>
        <p className="muted-copy">{g.suspended
          ? "The agent's key can trade nothing until you resume it. Its caps and vault are unchanged."
          : "Suspending stops every trade at once, whatever the agent is doing. You can resume it any time."}</p>
        <button className={`btn ${g.suspended ? "btn-gold" : "btn-ghost"} btn-sm`} disabled={Boolean(busy)} onClick={() => void run(
          "suspend",
          () => new Transaction().add(setSuspended(g.owner, !g.suspended)),
          g.suspended ? "Resumed: the agent can trade again, inside its caps." : "Suspended: the agent's key can trade nothing until you resume it.",
        )}>{label("suspend", g.suspended ? "Resume the agent" : "Suspend the agent")}</button>
      </article>

      <article>
        <h3>Vault</h3>
        <p className="muted-copy">It holds {usdc(g.vaultBalance)} test USDC. Your wallet holds {wallet === null ? "…" : usdc(wallet)}. Only you can move it in or out; the agent can only trade it.</p>
        <div className="field"><label htmlFor="own-amount">Amount (test USDC)</label><input id="own-amount" inputMode="decimal" placeholder="10" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="owner-actions">
          <button className="btn btn-gold btn-sm" disabled={Boolean(busy)} onClick={() => void run("deposit", () => {
            const a = amountOf(amount, "amount");
            if (wallet !== null && a > wallet) throw new Error(`Your wallet holds ${usdc(wallet)} test USDC.`);
            return new Transaction().add(depositUsdc({ depositor: g.owner, governorOwner: g.owner, vault: g.vault, depositorUsdc: ownerUsdc, usdcMint, tokenProgram: TOKEN_PROGRAM_ID, amount: a }));
          }, `Deposited ${amount} test USDC into the vault.`)}>{label("deposit", "Deposit")}</button>
          <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void run("withdraw", () => {
            const a = amountOf(amount, "amount");
            if (g.vaultBalance !== null && a > g.vaultBalance) throw new Error(`The vault holds ${usdc(g.vaultBalance)} test USDC.`);
            return new Transaction().add(
              createAssociatedTokenAccountIdempotent(g.owner, g.owner, usdcMint),
              withdrawUsdc({ owner: g.owner, vault: g.vault, destination: ownerUsdc, usdcMint, tokenProgram: TOKEN_PROGRAM_ID, amount: a }),
            );
          }, `Withdrew ${amount} test USDC to your wallet.`)}>{label("withdraw", "Withdraw to my wallet")}</button>
        </div>
      </article>

      <article>
        <h3>Agent key</h3>
        <p className="muted-copy">Now <KeyLink value={g.operator.toBase58()} />. A new key takes over when the change confirms, and the old one can no longer trade from this governor.</p>
        <div className="field"><label htmlFor="own-operator">New agent key</label><input id="own-operator" placeholder="the address the agent's keygen printed" value={operator} onChange={(e) => setOperatorText(e.target.value.trim())} /></div>
        <button className="btn btn-ghost btn-sm" disabled={Boolean(busy) || !operator} onClick={() => void run("operator", () => {
          let key: PublicKey;
          try { key = new PublicKey(operator); } catch { throw new Error("That is not a Solana address."); }
          if (key.equals(g.operator)) throw new Error("That is already the agent key.");
          if (key.equals(g.owner)) throw new Error("Give the agent a key of its own, not your wallet: the owner's key can move the vault.");
          return new Transaction().add(setOperator(g.owner, key));
        }, `The agent key is now ${shortKey(operator)}.`)}>{label("operator", "Replace the key")}</button>
      </article>
    </div>
    {outcome && <p className={`form-msg${outcome.ok ? "" : " err"}`}>{outcome.text}{outcome.ok && <> Transaction <KeyLink value={outcome.signature} kind="tx" /></>}</p>}
  </section>;
}
