import { ArrowUpRight } from "lucide-react";
import { useStore, type ReceiptView } from "../state";
import { explorerHref } from "./ExplorerShell";
import { agentName, CATEGORY_KEYS, CATEGORY_NAMES, native, shortAddr, shortHash, timeAgo } from "../lib/format";
import { txUrl } from "../lib/config";

export function ActivityTable({ rows, title = "Latest decisions" }: { rows?: ReceiptView[]; title?: string }) {
  const { cfg, agents, receipts } = useStore();
  const data = rows ?? receipts;
  const name = (id: bigint) => {
    const agent = agents.find(a => a.id === id);
    return agent ? agentName(agent.id, agent.metadataURI) : `Agent #${id}`;
  };
  return (
    <section className="data-section">
      <div className="section-heading"><div><span className="eyebrow">ON-CHAIN ACTIVITY</span><h2>{title}</h2></div><span className="row-count">{data.length} indexed</span></div>
      <div className="explorer-table-wrap">
        <table className="explorer-table activity-table">
          <thead><tr><th>Status</th><th>Decision</th><th>Agent</th><th>Purpose</th><th>Value</th><th>Payee</th><th>Age</th><th>Block</th></tr></thead>
          <tbody>
            {data.map(r => <tr key={`${r.txHash}-${r.metaHash}`}>
              <td><span className="status-inline"><i/>Settled</span></td>
              <td><a className="mono-link" href={explorerHref(`/decisions/${r.metaHash}`, cfg?.network)}>{shortHash(r.metaHash)}</a></td>
              <td><a className="table-primary" href={explorerHref(`/agents/${r.agentId}`, cfg?.network)}>{name(r.agentId)}</a><small>#{r.agentId.toString()}</small></td>
              <td><span className={`purpose purpose-${CATEGORY_KEYS[r.category]}`}>{CATEGORY_NAMES[r.category]}</span></td>
              <td className="numeric">{native(r.amount, cfg?.symbol, 6)}</td>
              <td className="mono-muted" title={r.payee}>{shortAddr(r.payee)}</td>
              <td title={new Date(r.timestamp).toLocaleString()}>{timeAgo(r.timestamp)}</td>
              <td>{cfg && txUrl(cfg, r.txHash) ? <a className="block-link" href={txUrl(cfg, r.txHash)!} target="_blank" rel="noreferrer">{r.blockNumber.toString()}<ArrowUpRight size={13}/></a> : r.blockNumber.toString()}</td>
            </tr>)}
            {!data.length && <tr><td className="table-empty" colSpan={8}>No governed decisions have been indexed on this network yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
