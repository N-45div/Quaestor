import { ArrowUpRight, Bot, Radio } from "lucide-react";
import { stocksBase } from "../../lib/stocks";
import { explorerTx, short, show } from "../../lib/evm/stocks";
import { AddressLink, useEvm, useHub } from "./common";

/**
 * Monad's house agent and its live tape, as the hub serves them: Kimi decides, a Dynamic MPC
 * wallet signs, Chainlink CRE starts each run after it writes fresh prices, and the governor
 * enforces the owner's limits; Alchemy's monadLogs shows each fill as its block is proposed.
 */
interface RunStep { tool: string; args: Record<string, unknown>; result: Record<string, unknown> | Record<string, unknown>[] }
interface Run { at: string; trigger: string; model: string; steps: RunStep[]; summary: string; tx?: string; error?: string }
interface AgentView { wallet: { address: string; kind: string }; model: string; mandate: string; startedBy: string; running: boolean; runs: Run[] }
interface Fill { key: string; governor: string; tx: string; stock: string; spent: string; received: string; pricePerShare: string; stage: string; proposedAt?: number; votedAt?: number; finalizedAt?: number }
interface LiveView { connected: boolean; fills: Fill[] }

const get = async <T,>(path: string): Promise<T> => {
  const res = await fetch(`${stocksBase()}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`The hub answered ${res.status}.`);
  return res.json() as Promise<T>;
};

const TRIGGER: Record<string, string> = { "chainlink-cre": "Chainlink CRE, after fresh prices", schedule: "its schedule", manual: "the owner", "live-check": "a live check" };
const time = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function MonadAgent() {
  const { net } = useEvm();
  const agent = useHub(() => get<AgentView>(`/v1/evm/${net.key}/agent`), [net.key], 20_000);
  const live = useHub(() => get<LiveView>(`/v1/evm/${net.key}/live`), [net.key], 3_000);
  if (net.key !== "monad-testnet" || (!agent.data && !live.data)) return null;
  const a = agent.data;
  const fills = live.data?.fills ?? [];

  return <>
    {a && (
      <section className="data-section">
        <div className="section-heading"><div><span className="eyebrow">THE HOUSE AGENT</span><h2>Kimi decides. Dynamic signs. The governor enforces.</h2></div><span className="row-count">{a.running ? "running now" : `${a.runs.length} recent run(s)`}</span></div>
        <div className="agent-explainer">
          <p><Bot size={16} /> An AI agent trades this budget on its own. <strong>{a.model}</strong> (Moonshot&rsquo;s Kimi) reads the portfolio and live Kuru quotes beside Chainlink, and buys at most one stock a run. Its key is a <strong>Dynamic MPC wallet</strong> <AddressLink value={a.wallet.address} /> that no single machine holds whole. Each run is started by {a.startedBy}. Whatever the model decides, the governor holds it to the owner&rsquo;s caps and prices.</p>
          <details><summary>The owner&rsquo;s mandate</summary><pre className="env-block">{a.mandate}</pre></details>
        </div>
        <div className="explorer-table-wrap">
          <table className="explorer-table">
            <thead><tr><th>When</th><th>Started by</th><th>What it did</th><th>Trade</th></tr></thead>
            <tbody>
              {a.runs.map((r) => (
                <tr key={r.at}>
                  <td>{time(r.at)}</td>
                  <td>{TRIGGER[r.trigger] ?? r.trigger}</td>
                  <td className="op-cell-text">{r.error ? `Did not finish: ${r.error}` : r.summary}<br /><small className="muted-copy">{r.steps.map((s) => s.tool).join(" → ") || "no tool calls"} · {r.model}</small></td>
                  <td>{r.tx ? <a className="mono-link" href={r.tx} target="_blank" rel="noreferrer">{short(r.tx.split("/").pop() ?? r.tx)}<ArrowUpRight size={12} /></a> : "—"}</td>
                </tr>
              ))}
              {!a.runs.length && <tr><td className="table-empty" colSpan={4}>No run since the hub started. The next one starts when Chainlink CRE writes fresh prices.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    )}

    {live.data && (
      <section className="data-section">
        <div className="section-heading"><div><span className="eyebrow"><Radio size={12} /> LIVE, FROM ALCHEMY</span><h2>Governed fills as their blocks are proposed</h2></div><span className="row-count">{live.data.connected ? "subscribed to monadLogs" : "reconnecting"}</span></div>
        <div className="explorer-table-wrap">
          <table className="explorer-table">
            <thead><tr><th>Stage</th><th>Bought</th><th>Spent</th><th>Price</th><th>Proposed → final</th><th>Trade</th></tr></thead>
            <tbody>
              {fills.map((f) => (
                <tr key={f.key}>
                  <td><span className={`status-inline${f.stage === "Finalized" ? "" : " warn"}`}><i />{f.stage}</span></td>
                  <td>{show(f.received, 6)} {f.stock}</td>
                  <td className="numeric">{show(f.spent)} {net.budget.symbol}</td>
                  <td className="numeric">{show(f.pricePerShare)}</td>
                  <td>{f.proposedAt && f.finalizedAt ? `${((f.finalizedAt - f.proposedAt) / 1000).toFixed(1)} s` : f.proposedAt ? "waiting" : "seen final"}</td>
                  <td><a className="mono-link" href={explorerTx(net, f.tx)} target="_blank" rel="noreferrer">{short(f.tx)}<ArrowUpRight size={12} /></a></td>
                </tr>
              ))}
              {!fills.length && <tr><td className="table-empty" colSpan={6}>No governed fill since the hub subscribed. One appears here the moment its block is proposed.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    )}
  </>;
}
