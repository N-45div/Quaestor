import { useEffect, useState } from "react";
import { ArrowRight, Copy, Globe2, PauseCircle } from "lucide-react";
import { AURORA_KEY, DESTINATIONS, ORIGINS, chainPause, quote, status, submitDeposit, units, type Quote, type StatusView } from "../../lib/aurora";
import { useEvm } from "./common";

/**
 * Fund an agent from any chain, through Aurora Intents: USDC or ETH from Base, Arbitrum, Ethereum
 * or Solana arrives on Monad as USDC (the agent's budget) or MON (its gas). Sent to a governor's
 * own address, USDC is the agent's budget the moment it lands: a governor's budget is its balance.
 */
const isEvm = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());
const isSolana = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a.trim());
const DONE = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

export function AuroraFund() {
  const { net } = useEvm();
  const [pause, setPause] = useState<{ since: string } | null | undefined>(undefined);
  const [originKey, setOriginKey] = useState(ORIGINS[0].key);
  const [destKey, setDestKey] = useState(DESTINATIONS[0].key);
  const [amount, setAmount] = useState("5");
  const [recipient, setRecipient] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [priced, setPriced] = useState<Quote | null>(null);
  const [open, setOpen] = useState<Quote | null>(null);
  const [txHash, setTxHash] = useState("");
  const [state, setState] = useState<StatusView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (AURORA_KEY) chainPause("monad").then(setPause).catch(() => setPause(null)); }, []);
  useEffect(() => {
    if (!open?.depositAddress || (state && DONE.has(state.status))) return;
    const t = setInterval(() => { status(open.depositAddress!).then(setState).catch(() => undefined); }, 6_000);
    return () => clearInterval(t);
  }, [open?.depositAddress, state?.status]);

  if (!AURORA_KEY || net.key !== "monad-testnet") return null;
  const origin = ORIGINS.find((o) => o.key === originKey)!;
  const dest = DESTINATIONS.find((d) => d.key === destKey)!;

  const problem = (): string | null => {
    if (!units(amount, origin.decimals)) return `Write the amount of ${origin.symbol} like 5 or 0.01.`;
    if (!isEvm(recipient)) return "The recipient is an address on Monad: the agent's governor, or your wallet.";
    if (origin.evm ? !isEvm(refundTo) : !isSolana(refundTo)) return `If the route fails, the money goes back to your address on ${origin.label.split(" on ")[1]}; give it.`;
    return null;
  };

  const ask = async (dry: boolean) => {
    setErr(null);
    const why = problem();
    if (why) return setErr(why);
    setBusy(dry ? "Asking Aurora's solvers…" : "Opening a deposit address…");
    try {
      const q = await quote({ origin, destinationAssetId: dest.assetId, amount: units(amount, origin.decimals)!, recipient: recipient.trim(), refundTo: refundTo.trim(), dry });
      if (dry) setPriced(q); else { setOpen(q); setState(null); }
    } catch (e) {
      const m = (e as Error).message;
      setErr(/not available/i.test(m) && pause ? "Aurora has no route to Monad while NEAR Intents keeps Monad paused. The quote will price as soon as it reopens." : m);
    } finally {
      setBusy(null);
    }
  };

  const tell = async () => {
    if (!open?.depositAddress || !txHash.trim()) return;
    setBusy("Telling Aurora…");
    try { await submitDeposit(open.depositAddress, txHash.trim()); setState(await status(open.depositAddress)); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <section className="data-section">
      <div className="section-heading"><div><span className="eyebrow"><Globe2 size={12} /> FUND FROM ANY CHAIN · AURORA INTENTS</span><h2>Top up an agent from wherever the money is</h2></div><span className="row-count">delivers on Monad mainnet</span></div>
      <div className="aurora-box">
        <p className="muted-copy">Send USDC or ETH from Base, Arbitrum, Ethereum or Solana; Aurora&rsquo;s solvers route it through NEAR Intents and deliver it on Monad. Sent to an agent&rsquo;s governor, USDC is its budget the moment it lands, because a governor&rsquo;s budget is its balance; MON pays the agent&rsquo;s gas. No bridge, no chain switching.</p>
        {pause && (
          <div className="aurora-pause"><PauseCircle size={16} /><span><strong>Monad is paused on NEAR Intents</strong> since {new Date(pause.since).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}, by NEAR Intents&rsquo; Shield, for deposits and withdrawals. Aurora can price nothing into or out of Monad until it reopens; this panel checks every time it opens.</span></div>
        )}
        <div className="form-grid aurora-grid">
          <div className="field"><label htmlFor="au-from">Send</label>
            <select id="au-from" value={originKey} onChange={(e) => { setOriginKey(e.target.value); setPriced(null); }}>{ORIGINS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select></div>
          <div className="field"><label htmlFor="au-amount">Amount ({origin.symbol})</label><input id="au-amount" value={amount} onChange={(e) => { setAmount(e.target.value); setPriced(null); }} inputMode="decimal" /></div>
          <div className="field"><label htmlFor="au-to">Arrive as</label>
            <select id="au-to" value={destKey} onChange={(e) => { setDestKey(e.target.value); setPriced(null); }}>{DESTINATIONS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></div>
          <div className="field"><label htmlFor="au-recipient">Recipient on Monad</label><input id="au-recipient" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x… the agent's governor, or your wallet" /></div>
          <div className="field" style={{ gridColumn: "1 / -1" }}><label htmlFor="au-refund">Refund address on the origin chain</label><input id="au-refund" value={refundTo} onChange={(e) => setRefundTo(e.target.value)} placeholder={origin.evm ? "0x… your address there" : "your Solana address"} /><div className="note">Where the money goes back if the route cannot complete.</div></div>
        </div>
        <div className="form-actions">
          <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => void ask(true)}>{busy && !open ? busy : "Price it"}</button>
          <button className="btn btn-gold btn-sm" disabled={!!busy || !priced || !!pause} onClick={() => void ask(false)}>Get the deposit address <ArrowRight size={14} /></button>
          {err ? <span className="form-msg err">{err}</span> : null}
        </div>
        {priced && !open && <p className="aurora-quote">{priced.amountInFormatted} {origin.symbol} → about <strong>{priced.amountOutFormatted} {dest.symbol}</strong> on Monad (${Number(priced.amountOutUsd).toFixed(2)}), in about {priced.timeEstimate} s.</p>}
        {open?.depositAddress && (
          <div className="aurora-deposit">
            <div><small>Send exactly {open.amountInFormatted} {origin.symbol} on {origin.label.split(" on ")[1]} to</small>
              <code>{open.depositAddress}</code>
              <span>Before {open.deadline ? new Date(open.deadline).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "the quote expires"}. About {open.amountOutFormatted} {dest.symbol} arrives at {recipient.slice(0, 8)}… on Monad.</span></div>
            <button className="btn btn-ghost btn-sm" onClick={() => void navigator.clipboard?.writeText(open.depositAddress!)}><Copy size={14} />Copy</button>
            <div className="aurora-track">
              <input value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="Your transfer's hash, to have it picked up sooner (optional)" />
              <button className="btn btn-ghost btn-sm" disabled={!!busy || !txHash} onClick={() => void tell()}>Sent it</button>
              <span className={`status-inline${state?.status === "SUCCESS" ? "" : " warn"}`}><i />{state?.status?.replace(/_/g, " ").toLowerCase() ?? "waiting for the deposit"}</span>
              {state?.swapDetails?.destinationChainTxHashes?.map((h) => <a key={h.hash} className="mono-link" href={h.explorerUrl ?? `https://monadscan.com/tx/${h.hash}`} target="_blank" rel="noreferrer">on Monad: {h.hash.slice(0, 10)}…</a>)}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
