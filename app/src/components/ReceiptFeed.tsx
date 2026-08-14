import { useState } from "react";
import { useStore, type ReceiptView } from "../state";
import { txUrl } from "../lib/config";
import {
  agentName,
  okb,
  shortAddr,
  shortHash,
  timeAgo,
  CATEGORY_NAMES,
  CATEGORY_KEYS,
} from "../lib/format";
import { ReceiptModal } from "./ReceiptModal";

export function ReceiptFeed() {
  const { receipts, agents, cfg } = useStore();
  const [open, setOpen] = useState<ReceiptView | null>(null);

  if (!receipts.length) {
    return (
      <div className="watchdog-empty">
        No receipts yet. The first governed spend will appear here the moment it
        settles.
      </div>
    );
  }

  const nameOf = (agentId: bigint) => {
    const a = agents.find((x) => x.id === agentId);
    return a ? agentName(a.id, a.metadataURI) : `Agent #${agentId}`;
  };

  return (
    <div className="table-wrap">
      <table className="receipts">
        <thead>
          <tr>
            <th>When</th>
            <th>Agent</th>
            <th>Category</th>
            <th>Amount</th>
            <th>Payee</th>
            <th>Decision hash</th>
            <th>Epoch spend after</th>
            <th>Proof</th>
          </tr>
        </thead>
        <tbody>
          {receipts.map((r) => {
            const url = cfg ? txUrl(cfg, r.txHash) : null;
            return (
              <tr
                key={`${r.txHash}-${r.metaHash}`}
                className="receipt-clickable"
                title="Open this receipt — fetch and verify the decision record"
                onClick={() => setOpen(r)}
              >
                <td className="mono" title={new Date(r.timestamp).toLocaleString()}>
                  {timeAgo(r.timestamp)}
                </td>
                <td>{nameOf(r.agentId)}</td>
                <td>
                  <span className="chip">
                    <span className={`dot dot-${CATEGORY_KEYS[r.category]}`} />
                    {CATEGORY_NAMES[r.category]}
                  </span>
                </td>
                <td className="amount">{okb(r.amount, 5)} OKB</td>
                <td className="addr" title={r.payee}>
                  {shortAddr(r.payee)}
                </td>
                <td className="addr" title={r.metaHash}>
                  {shortHash(r.metaHash)}
                </td>
                <td className="mono">{okb(r.epochSpentAfter, 5)} OKB</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {url ? (
                    <a className="tx-link" href={url} target="_blank" rel="noreferrer">
                      OKLink ↗
                    </a>
                  ) : (
                    <span className="addr" title={r.txHash}>
                      {shortHash(r.txHash)}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {open ? <ReceiptModal receipt={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
