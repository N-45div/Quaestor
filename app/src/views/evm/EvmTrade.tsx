import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, ShieldAlert } from "lucide-react";
import { explorerHref } from "../../components/ExplorerShell";
import { fetchRecord, fetchTrade, short, show, words, type RecordState } from "../../lib/evm/stocks";
import { AddressLink, useEvm, useHub } from "./common";

/** One settled trade: what the governor recorded, and the reason it committed to, re-hashed here. */
export function EvmTrade({ tx }: { tx: string }) {
  const { net } = useEvm();
  const view = useHub(() => fetchTrade(net.key, tx), [net.key, tx], 0);
  const [record, setRecord] = useState<RecordState>({ kind: "loading" });
  const t = view.data?.trade;

  useEffect(() => {
    if (!t) return;
    let live = true;
    setRecord({ kind: "loading" });
    fetchRecord(t.decisionHash).then((r) => live && setRecord(r));
    return () => { live = false; };
  }, [t?.decisionHash]);

  if (view.error) return <div className="not-found"><strong>No trade {short(tx)} on {net.name}.</strong><p>{view.error}</p><a href={explorerHref(`/evm/${net.key}`)}>{net.name} overview</a></div>;
  if (!view.data) return <div className="not-found"><strong>Reading trade {short(tx)}…</strong></div>;
  const v = view.data;
  if (!t) return <div className="not-found"><strong>{short(tx)} is not a settled trade.</strong><p>{v.status === 0 ? "It reverted: the governor refused it, and nothing moved." : "It emitted no TradeExecuted event."} <AddressLink value={tx} kind="tx" /></p></div>;

  let parsed: Record<string, unknown> | null = null;
  if (record.kind === "verified") {
    try { parsed = JSON.parse(record.raw) as Record<string, unknown>; } catch { parsed = null; }
  }

  return <>
    <section className="page-intro compact"><div>
      <a className="back-link" href={explorerHref(`/evm/${net.key}/agents/${v.governor}`)}><ArrowLeft size={13} />The agent</a>
      <span className="eyebrow">A SETTLED TRADE · {net.name.toUpperCase()}</span>
      <h1>{show(t.spent)} {net.budget.symbol} → {show(t.received, 8)} {t.stock}</h1>
      <p>At {show(t.pricePerShare)} {net.budget.symbol} a {words(net).unit}, measured by the governor from its own balances. Transaction <AddressLink value={v.tx} kind="tx" />{v.at ? `, ${new Date(v.at * 1000).toLocaleString()}` : ""}.</p>
    </div></section>

    <section className="data-section">
      <div className="kv-grid">
        <div><span>Governor</span><AddressLink value={v.governor} /></div>
        <div><span>Agent key</span>{v.operator ? <AddressLink value={v.operator} /> : "—"}</div>
        <div><span>Venue</span><AddressLink value={t.venue} /></div>
        <div><span>{words(net).Asset === "Stock" ? "Stock token" : "Token"}</span><AddressLink value={t.token} /></div>
        <div><span>Intent id</span><code title={t.intentId}>{t.intentId.slice(0, 18)}…</code></div>
        <div><span>Spent this epoch after it</span>{show(t.epochSpent)} {net.budget.symbol}</div>
        <div><span>Decision hash on chain</span><code title={t.decisionHash}>{t.decisionHash.slice(0, 18)}…</code></div>
      </div>
    </section>

    <section className="data-section">
      <div className="section-heading"><div><span className="eyebrow">THE AGENT&rsquo;S REASON</span><h2>Re-hashed in your browser</h2></div></div>
      {record.kind === "loading" ? <p className="muted-copy">Fetching the record from the ledger…</p>
        : record.kind === "verified" ? <>
          <p className="verify-ok"><CheckCircle2 size={16} />Hash matches: this is exactly the record the trade committed to on chain.</p>
          {parsed?.reason ? <blockquote className="reason-quote">{String(parsed.reason)}</blockquote> : null}
          <pre className="env-block">{JSON.stringify(parsed ?? record.raw, null, 2)}</pre>
        </>
        : record.kind === "mismatch" ? <p className="verify-bad"><ShieldAlert size={16} />The ledger returned a record that does not hash to what the chain committed to. Trust the chain.</p>
        : record.kind === "missing" ? <p className="muted-copy">The ledger does not hold this record (yet). The hash on chain still binds any record published later.</p>
        : <p className="form-msg err">{record.message}</p>}
    </section>
  </>;
}
