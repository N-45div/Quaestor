import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, XCircle } from "lucide-react";
import { keccak256, toBytes } from "viem";
import { fetchDecision, opHref, type OpDecision as Decision } from "../../lib/operator";
import { when } from "./parts";

/** The record behind a payment, re-hashed here in the browser against the hash the chain holds. */
export function OpDecision({ hash }: { hash: string }) {
  const [d, setD] = useState<Decision | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { fetchDecision(hash).then(setD).catch((e) => setErr((e as Error).message)); }, [hash]);
  if (err) return <div className="not-found"><strong>No public decision with that hash.</strong><p>{err}</p></div>;
  if (!d) return <div className="not-found"><strong>Reading the record…</strong></div>;
  const matches = keccak256(toBytes(d.record)).toLowerCase() === hash.toLowerCase();
  const project = typeof d.parsed.project === "string" ? d.parsed.project : null;
  return <>
    <section className="page-intro compact"><div>
      {project ? <a className="back-link" href={opHref(`/p/${project}`)}><ArrowLeft size={13} />The project</a> : null}
      <span className="eyebrow">DECISION RECORD · {d.kind.replace("_", " ").toUpperCase()}</span>
      <h1>Why this money moved</h1>
      <p>The operator wrote this record when it decided, and put its keccak-256 hash on-chain with the payment. This page re-hashes the text it was served.</p>
    </div></section>
    <section className={`op-verify ${matches ? "ok" : "bad"}`}>
      {matches ? <CheckCircle2 size={20} /> : <XCircle size={20} />}
      <div><strong>{matches ? "The record matches its hash." : "The record does not match its hash."}</strong><span className="mono">{hash}</span><small>Recorded {when(d.at)}</small></div>
    </section>
    {typeof d.parsed.reasoning === "string" && <section className="op-answer"><div><span className="eyebrow">THE REASONING</span></div><p>{d.parsed.reasoning}</p></section>}
    <section className="data-section"><div className="section-heading"><div><span className="eyebrow">THE EXACT TEXT</span><h2>As hashed</h2></div></div><pre className="env-block op-record">{d.record}</pre></section>
  </>;
}
