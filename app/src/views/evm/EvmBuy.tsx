import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Bot, ShieldCheck } from "lucide-react";
import { createPublicClient, http, type Hex } from "viem";
import { explorerHref } from "../../components/ExplorerShell";
import { budgetOf, chainOf, fetchGovernor, parseUnits, short, show, withBudget, words, type GovernorView } from "../../lib/evm/stocks";
import { quoteBuy, type PageQuote } from "../../lib/evm/quote";
import { AddressLink, OwnerWallet, useEvm } from "./common";

const SLIPPAGE_BPS = 100n;
const fmtUnits = (v: bigint, d: number, digits = 6) => (Number(v) / 10 ** d).toLocaleString("en-US", { maximumFractionDigits: digits });

/**
 * A buy page for an agent's browser. It trades from whatever account the wallet
 * gives it, and it is meant for Quaestor Wallet, whose account is the agent's
 * governor: the page proposes a swap, the wallet reads the intent out of it, and
 * the governor's checks decide. Every field is labelled and every answer is
 * written out, so an agent reading the page sees what a person would.
 */
export function EvmBuy() {
  const { net: chain, owner } = useEvm();
  const [gov, setGov] = useState<GovernorView | null>(null);
  const [notGovernor, setNotGovernor] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [amount, setAmount] = useState("2");
  const [reason, setReason] = useState("");
  const [quote, setQuote] = useState<PageQuote | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; tx?: Hex } | null>(null);

  // The connected account's governor, if it is one.
  useEffect(() => {
    setGov(null); setNotGovernor(false); setQuote(null); setMsg(null);
    if (!owner) return;
    fetchGovernor(chain.key, owner.account).then(setGov).catch(() => setNotGovernor(true));
  }, [owner?.account, chain.key]);

  const budget = gov ? budgetOf(chain, gov.budgetToken) ?? chain.budget : chain.budget;
  const net = withBudget(chain, budget);
  const allowed = useMemo(() => net.instruments.filter((i) => gov?.instruments.some((g) => g.allowed && g.address.toLowerCase() === i.address.toLowerCase())), [net, gov]);
  useEffect(() => { if (allowed.length && !allowed.some((i) => i.symbol === symbol)) setSymbol(allowed[0].symbol); }, [allowed, symbol]);
  const inst = allowed.find((i) => i.symbol === symbol);
  const amountIn = parseUnits(amount, budget.decimals);

  const getQuote = async () => {
    setMsg(null); setQuote(null);
    if (!inst || !amountIn) return setMsg({ ok: false, text: `Write an amount of ${budget.symbol}, such as 2.` });
    setBusy("Quoting…");
    try { setQuote(await quoteBuy(net, inst, amountIn)); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(null); }
  };

  const buy = async () => {
    if (!owner || !gov || !inst || !amountIn || !quote) return;
    if (!reason.trim()) return setMsg({ ok: false, text: "Write the reason for this buy; it is committed on chain with the trade." });
    setMsg(null);
    setBusy("Buying through the governor…");
    try {
      const minOut = (quote.amountOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      const hash = await owner.client.request({
        method: "eth_sendTransaction",
        params: [{ from: owner.account, to: quote.router, data: quote.swap(owner.account, minOut), value: "0x0", reason: reason.trim() }],
      } as never) as Hex;
      setBusy("Waiting for the block…");
      await createPublicClient({ chain: chainOf(chain), transport: http(chain.rpcUrl) }).waitForTransactionReceipt({ hash });
      setMsg({ ok: true, text: `Bought ${inst.symbol} for ${amount} ${budget.symbol}.`, tx: hash });
      setQuote(null);
      fetchGovernor(chain.key, owner.account).then(setGov).catch(() => undefined);
    } catch (e) {
      const err = e as { message?: string; shortMessage?: string; cause?: { message?: string } };
      setMsg({ ok: false, text: `Refused: ${err.cause?.message ?? err.shortMessage ?? err.message ?? String(e)}` });
    } finally {
      setBusy(null);
    }
  };

  return <>
    <section className="page-intro compact"><div>
      <a className="back-link" href={explorerHref(`/evm/${chain.key}`)}><ArrowLeft size={13} />{chain.name}</a>
      <span className="eyebrow">BUY · {chain.name.toUpperCase()}</span>
      <h1>Buy {words(chain).assets} from a governor</h1>
      <p>For an agent&rsquo;s browser. Connect Quaestor Wallet, whose account is the agent&rsquo;s governor: this page proposes a buy, the wallet reads what it asks for, and the governor&rsquo;s caps, the owner&rsquo;s limit price and Chainlink&rsquo;s price decide. The page never holds a key.</p>
    </div></section>

    <section className="manage-area register-area">
      <div className="manage-notice">
        <Bot size={22} />
        <div><h2>{gov ? "Connected to a governor" : "Connect the agent's wallet"}</h2><p>{gov ? <>Governor <AddressLink value={gov.address} /> · owner <AddressLink value={gov.owner} /> · agent key <AddressLink value={gov.operator} />{gov.suspended ? " · suspended by its owner" : ""}</> : "Quaestor Wallet runs on the agent's own computer and only ever asks its governor to buy."}</p></div>
        <OwnerWallet onError={(m) => setMsg({ ok: false, text: m })} />
      </div>

      {notGovernor ? (
        <div className="form-card"><p className="muted-copy">{owner ? `${short(owner.account)} is not a governor on ${chain.name}.` : ""} This page buys from a Quaestor governor. Open it in a browser whose wallet is Quaestor Wallet, or <a href={explorerHref(`/evm/${chain.key}/register`)}>open a governor</a> first.</p></div>
      ) : gov ? (
        <div className="form-card buy-card">
          <div className="buy-limits" aria-label="The governor's limits">
            <div><span>Can spend now</span><b>{show(gov.remaining)} {budget.symbol}</b></div>
            <div><span>Per trade</span><b>{show(gov.perTradeCap)} {budget.symbol}</b></div>
            <div><span>In the governor</span><b>{show(gov.budget)} {budget.symbol}</b></div>
          </div>
          <div className="form-grid">
            <div className="field"><label htmlFor="buy-stock">{words(chain).Asset}</label>
              <select id="buy-stock" value={symbol} onChange={(e) => { setSymbol(e.target.value); setQuote(null); }}>
                {allowed.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol} · {i.name}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="buy-amount">Amount ({budget.symbol})</label><input id="buy-amount" value={amount} onChange={(e) => { setAmount(e.target.value); setQuote(null); }} inputMode="decimal" /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label htmlFor="buy-reason">Reason</label><input id="buy-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this buy: committed on chain with the trade" maxLength={500} /></div>
          </div>
          {quote && inst ? (
            <div className="buy-quote" role="status">
              <p><b>{fmtUnits(quote.amountOut, inst.decimals)} {inst.symbol}</b> for {amount} {budget.symbol}, at {fmtUnits(quote.price, budget.decimals, 2)} {budget.symbol} a {words(chain).unit}, on the {quote.venueLabel}.</p>
              <p>{quote.chainlink !== null ? <>Chainlink: {fmtUnits(quote.chainlink, budget.decimals, 2)} · {quote.premiumBps! >= 0 ? `${quote.premiumBps} bps over` : `${-quote.premiumBps!} bps under`}.</> : "No Chainlink price for this token."} Floor {fmtUnits((quote.amountOut * (10_000n - SLIPPAGE_BPS)) / 10_000n, inst.decimals)} {inst.symbol} (1% under the quote).</p>
            </div>
          ) : null}
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => void getQuote()} disabled={Boolean(busy) || !inst}>Get a quote</button>
            <button className="btn btn-gold" onClick={() => void buy()} disabled={Boolean(busy) || !quote}>{busy ?? "Buy"}</button>
            {msg ? <span className={`form-msg${msg.ok ? "" : " err"}`} role="alert">{msg.text} {msg.tx ? <a href={explorerHref(`/evm/${chain.key}/trades/${msg.tx}`)}>The trade and its reason</a> : null}</span> : null}
          </div>
          <div className="note"><ShieldCheck size={13} /> A buy over the caps, over the owner&rsquo;s limit or too far over Chainlink is refused by the governor, whatever this page sends.</div>
        </div>
      ) : owner ? (
        <div className="form-card"><p className="muted-copy">Reading {short(owner.account)}…</p></div>
      ) : null}
    </section>
  </>;
}
