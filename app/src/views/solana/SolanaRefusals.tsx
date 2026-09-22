import { useState } from "react";
import { ArrowUpRight, ShieldX, Zap } from "lucide-react";
import { stocksBase } from "../../lib/stocks";
import { REFUSALS, explorerUrl } from "../../lib/solana/devnet";
import { units } from "../../lib/solana/chain";

type Kind = "overpay" | "short" | "over-cap";

interface DemoResult {
  kind: Kind;
  signature: string;
  explorer: string;
  code: string | null;
  venue_succeeded: boolean;
  amount_in_usdc: string;
  floor: string;
  curve_pays: string;
  per_trade_cap_usdc: string;
  limit_price_usdc?: string;
  fair_output?: string;
  vault_before: string;
  vault_after: string;
  position_before: string;
  position_after: string;
}

const ATTACKS: { kind: Kind; label: string; what: string }[] = [
  { kind: "overpay", label: "Be a hijacked agent", what: "A 1 USDC buy with the floor set to one base unit, through a pool that hands back one hundred-millionth of a token. The caps, the venue and the floor all pass." },
  { kind: "short", label: "Demand twice what the curve pays", what: "A 1 USDC buy on Meteora's curve with a floor of twice what it pays, and the curve told to accept anything." },
  { kind: "over-cap", label: "Spend over the cap", what: "A buy of one USDC more than the governor's on-chain per-trade cap." },
];

const usdc = (raw: string) => units(BigInt(raw), 6, 6);
const tokens = (raw: string) => units(BigInt(raw), 6, 6);
/** The hijacked agent buys dAAPLx, which has eight decimals. */
const shares = (raw: string) => units(BigInt(raw), 8, 8);
/** What the hijacked trade paid for one whole dAAPLx, in USDC. */
const perToken = (r: DemoResult) => (BigInt(r.curve_pays) > 0n ? units((BigInt(r.amount_in_usdc) * 100_000_000n) / BigInt(r.curve_pays), 6, 0) : "—");

/** What the visitor's own attempt did, in words, with the proof that nothing moved. */
function Outcome({ r }: { r: DemoResult }) {
  const moved = r.vault_before !== r.vault_after || r.position_before !== r.position_after;
  return (
    <div className={`demo-outcome ${r.code ? "refused" : "settled"}`}>
      <div className="refusal-top"><ShieldX size={16} /><code>{r.code ?? "NOT REFUSED"}</code></div>
      <p>{r.kind === "overpay"
        ? <>The agent set its floor to {shares(r.floor)} dAAPLx and paid {usdc(r.amount_in_usdc)} USDC into a pool that gave back {shares(r.curve_pays)}; a fair fill was {r.fair_output ? shares(r.fair_output) : "far more"}. The pool&rsquo;s swap {r.venue_succeeded ? "succeeded" : "did not complete"} and every cap passed, but that is {perToken(r)} USDC a token against the owner&rsquo;s limit of {usdc(r.limit_price_usdc ?? "0")}, so the program reverted the whole trade.</>
        : r.kind === "short"
        ? <>The floor was {tokens(r.floor)} qAAPLdemo; the curve pays {tokens(r.curve_pays)}. Meteora&rsquo;s swap {r.venue_succeeded ? "succeeded" : "did not complete"}, and the program measured the position and reverted the whole trade.</>
        : <>The agent asked to spend {usdc(r.amount_in_usdc)} USDC against a per-trade cap of {usdc(r.per_trade_cap_usdc)}. The program refused before the venue was called.</>}</p>
      <p className="demo-balances">Vault {usdc(r.vault_before)} → {usdc(r.vault_after)} USDC · position {r.kind === "overpay" ? `${shares(r.position_before)} → ${shares(r.position_after)} dAAPLx` : `${tokens(r.position_before)} → ${tokens(r.position_after)} qAAPLdemo`} · {moved ? "a balance changed while this ran (another trade?)" : "nothing moved"}</p>
      <a className="mono-link" href={r.explorer} target="_blank" rel="noreferrer">Your transaction {r.signature.slice(0, 8)}…<ArrowUpRight size={12} /></a>
    </div>
  );
}

/**
 * What the program would not let through. Every row in the trades tables is a
 * trade that passed; the point of a governor is the ones that did not, and on
 * a block explorer those look like any failed transaction. A visitor can cause
 * a refusal here, and the cards below are the ones on record.
 */
export function SolanaRefusals() {
  const [busy, setBusy] = useState<Kind | null>(null);
  const [result, setResult] = useState<DemoResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const attempt = async (kind: Kind) => {
    setBusy(kind);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${stocksBase()}/v1/stocks/demo/refusal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 429) throw new Error("You have tried this a few times already; the hub allows four every ten minutes. The cards below are earlier refusals.");
      if (!res.ok) throw new Error(body?.error?.message ?? `The hub answered ${res.status}.`);
      setResult(body as DemoResult);
    } catch (e) {
      setError((e as Error).name === "TimeoutError" ? "The hub did not answer in two minutes; a free instance may be waking. Try once more." : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="data-section refusals-section">
      <div className="section-heading"><div><span className="eyebrow">REFUSED ON CHAIN</span><h2>What the program would not let through</h2></div><span className="row-count">Devnet transactions</span></div>

      <div className="demo-box">
        <div className="demo-copy">
          <h3><Zap size={16} />Try to break it</h3>
          <p>Send the house agent&rsquo;s governor a trade it must refuse. It goes straight to the program on devnet, past every check the hub makes first, signed by the hub&rsquo;s operator. It costs a network fee, moves nothing, and usually answers in under ten seconds.</p>
        </div>
        <div className="demo-actions">
          {ATTACKS.map((a) => (
            <button key={a.kind} type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void attempt(a.kind)} title={a.what}>
              {busy === a.kind ? "Sending to devnet…" : a.label}
            </button>
          ))}
        </div>
        {error && <p className="form-msg err">{error}</p>}
        {result && <Outcome r={result} />}
      </div>

      <p className="muted-copy refusals-intro">A refused trade moves nothing and leaves no record, so it is not in the tables below. On the explorer each shows as a failed transaction; its logs name the check.</p>
      <div className="refusal-grid">
        {REFUSALS.map((r) => (
          <article key={r.signature}>
            <div className="refusal-top"><ShieldX size={16} /><code>{r.code}</code></div>
            <p>{r.what}</p>
            <div className="refusal-proof">
              <span>Logs: <code>Error Code: {r.code}</code> · custom error {r.errorNumber}</span>
              <a className="mono-link" href={explorerUrl("tx", r.signature)} target="_blank" rel="noreferrer">{r.signature.slice(0, 8)}…<ArrowUpRight size={12} /></a>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
