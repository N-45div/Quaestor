import { useEffect, useState } from "react";
import { ArrowLeft, Check, FileKey2, Link2, X } from "lucide-react";
import { keccak256, toBytes } from "viem";
import { explorerHref } from "../../components/ExplorerShell";
import { DEVNET, MINT_NAMES, VENUE_NAMES } from "../../lib/solana/devnet";
import { readTradeTx, shortKey, units, type TradeToken, type TradeTx, type TradeView } from "../../lib/solana/chain";
import { useSolana } from "../../lib/solana/store";
import { KeyLink, agentLabel, usdc } from "./common";

type RecordState =
  | { kind: "loading" }
  | { kind: "missing"; since?: string }
  | { kind: "verified"; raw: string; from: "ledger" | "pasted" }
  | { kind: "mismatch" }
  | { kind: "error"; message: string };

const rehash = (text: string) => keccak256(toBytes(text)).toLowerCase();

/**
 * The bytes in `text` that hash to `hash`, if any. The ledger serves the exact
 * string; a pasted record may be that string, the same JSON reformatted, or
 * the file the agent's command saves, which holds it under "record". The hash
 * decides, so being lenient about what is pasted cannot pass a wrong record.
 */
export function matchRecord(text: string, hash: string): string | null {
  const candidates = [text, text.trim()];
  try {
    const parsed = JSON.parse(text) as unknown;
    candidates.push(JSON.stringify(parsed));
    if (parsed && typeof parsed === "object" && "record" in parsed) candidates.push(JSON.stringify((parsed as { record: unknown }).record));
  } catch {
    // Not JSON: only the text as pasted can match.
  }
  return candidates.find((c) => rehash(c) === hash.toLowerCase()) ?? null;
}

/**
 * The intent hash as the agent command (quaestor-sol) makes it: the trade's
 * governor, token, amount and floor, bound to the record's hash. Another
 * agent may hash its intent its own way, so a mismatch proves nothing.
 */
export function commandIntentHash(t: TradeView, mint: string): string {
  return rehash(JSON.stringify({
    intentId: t.intentId,
    governor: t.governor,
    instrumentMint: mint,
    amountInUsdc: t.amountAuthorized.toString(),
    minOutput: t.minOutput.toString(),
    decisionRecordHash: t.decisionRecordHash,
  }));
}

async function fetchRecord(hash: string): Promise<RecordState> {
  try {
    // A free host may be waking, which takes up to a minute.
    const res = await fetch(`${DEVNET.ledgerUrl}/decisions/${hash}`, { signal: AbortSignal.timeout(75_000) });
    if (res.status === 404) {
      const body = (await res.json().catch(() => ({}))) as { retainedSince?: string };
      return { kind: "missing", since: body.retainedSince };
    }
    if (!res.ok) return { kind: "error", message: `The ledger answered ${res.status}.` };
    const raw = await res.text();
    return rehash(raw) === hash.toLowerCase() ? { kind: "verified", raw, from: "ledger" } : { kind: "mismatch" };
  } catch (e) {
    return { kind: "error", message: `The ledger did not answer (${(e as Error).message}).` };
  }
}

/** One settled trade: what the program recorded, the transaction behind it, and the decision it committed to, re-hashed here. */
export function SolanaTrade({ address }: { address: string }) {
  const { conn, governors, trades, tokens, ready } = useSolana();
  const t = trades.find((x) => x.address === address);
  const g = t ? governors.find((x) => x.address === t.governor) : undefined;
  const [tx, setTx] = useState<TradeTx | null | undefined>(undefined);
  const [record, setRecord] = useState<RecordState>({ kind: "loading" });

  useEffect(() => {
    if (!t) return;
    let live = true;
    readTradeTx(conn, t).then((x) => live && setTx(x)).catch(() => live && setTx(null));
    return () => { live = false; };
  }, [conn, t?.address]);

  useEffect(() => {
    if (!t) return;
    let live = true;
    setRecord({ kind: "loading" });
    fetchRecord(t.decisionRecordHash).then((r) => live && setRecord(r));
    return () => { live = false; };
  }, [t?.decisionRecordHash]);

  if (!ready) return <div className="not-found"><strong>Reading trade {shortKey(address)}…</strong><p>Fetching its record from devnet.</p></div>;
  if (!t) return <div className="not-found"><strong>No trade record at {shortKey(address)}.</strong><p>The program has written no IntentRecord there.</p><a href={explorerHref("/sol/trades")}>Back to trades</a></div>;

  const token: TradeToken | undefined = tx?.mint && tx.decimals !== null ? { mint: tx.mint, decimals: tx.decimals } : tokens[t.address];
  const tokenName = token ? MINT_NAMES[token.mint] ?? shortKey(token.mint) : "base units";
  const amount = (n: bigint) => (token ? units(n, token.decimals, 6) : n.toLocaleString("en-US"));
  const agent = g ? agentLabel(g) : `Governor ${shortKey(t.governor)}`;

  return <>
    <a className="back-link" href={explorerHref("/sol/trades")}><ArrowLeft size={15} />All trades</a>
    <section className="decision-hero">
      <div className="decision-glyph purpose-bg-execution"><FileKey2 /></div>
      <div><span className="eyebrow">SETTLED TRADE · SOLANA DEVNET</span><h1>{amount(t.actualOutput)} {tokenName}</h1><p>for {usdc(t.amountSpent, 6)} test USDC · {agent} · {new Date(t.settledAt).toLocaleString()}</p></div>
      <span className="state-badge live"><Check size={12} />Settled</span>
    </section>

    <section className="decision-grid">
      <article><span className="eyebrow">TRADE</span><div className="decision-amount">{usdc(t.amountSpent, 6)} USDC</div><dl>
        <div><dt>Agent</dt><dd><a href={explorerHref(`/sol/agents/${t.governor}`)}>{agent}</a></dd></div>
        <div><dt>Received</dt><dd>{amount(t.actualOutput)} {tokenName}</dd></div>
        <div><dt>Floor</dt><dd>{amount(t.minOutput)} {tokenName} <small className="dim">the least the program would accept</small></dd></div>
        <div><dt>Authorised</dt><dd>{usdc(t.amountAuthorized, 6)} USDC</dd></div>
        <div><dt>Venue</dt><dd>{tx === undefined ? "Reading…" : tx?.venue ? VENUE_NAMES[tx.venue] : "Not one this page knows"}</dd></div>
        <div><dt>Epoch</dt><dd>#{t.epoch.toString()}{g && g.epochLength > 0n && <small className="dim"> the budget period from {new Date(Number(t.epoch * g.epochLength) * 1000).toLocaleString()}</small>}</dd></div>
      </dl></article>
      <article><span className="eyebrow">ON-CHAIN PROOF</span><dl>
        <div><dt>Transaction</dt><dd>{tx ? <KeyLink value={tx.signature} kind="tx" /> : tx === null ? "Could not be read" : "Reading…"}</dd></div>
        <div><dt>Record</dt><dd><KeyLink value={t.address} /></dd></div>
        <div><dt>Intent id</dt><dd className="break-all">{t.intentId}</dd></div>
        <div><dt>Intent hash</dt><dd className="break-all">{t.decisionHash}</dd></div>
        <div><dt>Record hash</dt><dd className="break-all">{t.decisionRecordHash}</dd></div>
      </dl></article>
    </section>

    <section className="record-section">
      <div className="section-heading"><div><span className="eyebrow">WHY THE AGENT TRADED</span><h2>Decision record</h2></div>
        {record.kind === "verified" ? <span className="verify-state good"><Check />Hash matches</span> : record.kind === "mismatch" ? <span className="verify-state bad"><X />Hash mismatch</span> : null}</div>
      {record.kind === "loading" && <div className="record-state">Asking the ledger for the record this trade committed to. A free host can take up to a minute to wake.</div>}
      {record.kind === "verified" && <VerifiedRecord t={t} raw={record.raw} from={record.from} mint={token?.mint} />}
      {record.kind === "mismatch" && <div className="record-state"><X /><div><strong>The ledger's bytes do not match the hash on chain</strong><p>What it served is not the record this trade committed to.</p></div></div>}
      {(record.kind === "missing" || record.kind === "error") && <>
        <div className="record-state"><Link2 /><div>
          <strong>{record.kind === "missing" ? "The ledger does not hold this record" : "The ledger is unavailable"}</strong>
          <p>{record.kind === "missing"
            ? `It keeps what agents publish${record.since ? ` since it last started (${new Date(record.since).toLocaleString()})` : ""}, and the agent may never have published this one. `
            : `${record.message} `}
            The hash on chain binds the record whenever it turns up.</p>
        </div></div>
        <PasteRecord hash={t.decisionRecordHash} onMatch={(raw) => setRecord({ kind: "verified", raw, from: "pasted" })} />
      </>}
    </section>
  </>;
}

function VerifiedRecord({ t, raw, from, mint }: { t: TradeView; raw: string; from: "ledger" | "pasted"; mint: string | undefined }) {
  const data = JSON.parse(raw) as Record<string, unknown>;
  const intentBinds = mint ? commandIntentHash(t, mint) === t.decisionHash.toLowerCase() : null;
  // The command writes action and inputs; the hub's own agent writes strategy
  // and the price gate's evidence. Show whichever this record has.
  const evidence = data.inputs ?? data.market_evidence;
  return <div className="record-detail">
    {data.action !== undefined && <div><span>Action</span><strong>{String(data.action)}</strong></div>}
    {data.strategy !== undefined && <div><span>Strategy</span><strong>{String(data.strategy)}</strong></div>}
    {data.action === undefined && data.strategy === undefined && <div><span>Action</span><strong>Not stated in the record</strong></div>}
    <div><span>Rationale</span><strong>{String(data.rationale ?? "No rationale field")}</strong></div>
    <div><span>Record hash</span><strong>Your browser hashed the {from === "ledger" ? "ledger's" : "pasted"} bytes: keccak256 is the record hash this trade stored on chain.</strong></div>
    <div><span>Intent hash</span><strong>{intentBinds === null ? "Waiting for the trade's token to re-derive it."
      : intentBinds ? "Re-derived here from this record and the trade's governor, token, amount and floor: it matches the intent hash on chain."
      : "Made by this agent's own scheme, which this page does not re-derive. The record hash is what binds the explanation."}</strong></div>
    {evidence !== undefined && <pre>{JSON.stringify(evidence, null, 2)}</pre>}
  </div>;
}

function PasteRecord({ hash, onMatch }: { hash: string; onMatch: (raw: string) => void }) {
  const [text, setText] = useState("");
  const [miss, setMiss] = useState(false);
  const check = () => {
    const raw = matchRecord(text, hash);
    if (raw) onMatch(raw);
    else setMiss(true);
  };
  return <div className="paste-record field">
    <label htmlFor="paste-record">Have the record? Check it here</label>
    <p className="note">The agent command keeps a copy of each record it commits, in <code>~/.quaestor/solana-records/&lt;signature&gt;.json</code>. Paste that file or the record itself: your browser hashes it and compares the result with the hash on chain. Nothing is sent anywhere.</p>
    <textarea id="paste-record" rows={6} spellCheck={false} value={text} onChange={(e) => { setText(e.target.value); setMiss(false); }} />
    <div className="form-actions"><button type="button" className="btn btn-gold btn-sm" disabled={!text.trim()} onClick={check}>Check the hash</button>
      {miss && <span className="verify-state bad"><X />These bytes do not hash to {hash.slice(0, 12)}…, so this is not the record this trade committed to.</span>}</div>
  </div>;
}
