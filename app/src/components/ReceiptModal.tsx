import { useEffect, useState } from "react";
import { keccak256, toBytes } from "viem";
import { useStore, type ReceiptView } from "../state";
import { txUrl } from "../lib/config";
import { agentName, okb, CATEGORY_NAMES, CATEGORY_KEYS } from "../lib/format";

type VerifyState =
  | { kind: "loading" }
  | { kind: "no-ledger" }
  | { kind: "not-published" }
  | { kind: "verified"; record: Record<string, unknown>; raw: string }
  | { kind: "mismatch"; raw: string }
  | { kind: "error"; message: string };

/**
 * Opens an on-chain Receipt: fetches the published decision record and
 * re-computes keccak256 IN THE BROWSER against the receipt's metaHash.
 * Trust in the ledger service is never required — only availability.
 */
export function ReceiptModal({
  receipt,
  onClose,
}: {
  receipt: ReceiptView;
  onClose: () => void;
}) {
  const { cfg, agents } = useStore();
  const [state, setState] = useState<VerifyState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cfg?.decisionLedgerUrl) {
        setState({ kind: "no-ledger" });
        return;
      }
      try {
        const res = await fetch(
          `${cfg.decisionLedgerUrl}/decisions/${receipt.metaHash.toLowerCase()}`
        );
        if (cancelled) return;
        if (res.status === 404) {
          setState({ kind: "not-published" });
          return;
        }
        if (!res.ok) throw new Error(`ledger returned ${res.status}`);
        const raw = await res.text();
        const computed = keccak256(toBytes(raw));
        if (computed.toLowerCase() !== receipt.metaHash.toLowerCase()) {
          setState({ kind: "mismatch", raw });
          return;
        }
        setState({ kind: "verified", record: JSON.parse(raw), raw });
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg, receipt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const agent = agents.find((a) => a.id === receipt.agentId);
  const url = cfg ? txUrl(cfg, receipt.txHash) : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">
              Receipt · {agent ? agentName(agent.id, agent.metadataURI) : `Agent #${receipt.agentId}`}
            </div>
            <div className="modal-sub">
              <span className="chip">
                <span className={`dot dot-${CATEGORY_KEYS[receipt.category]}`} />
                {CATEGORY_NAMES[receipt.category]}
              </span>{" "}
              <span className="amount">{okb(receipt.amount, 6)} OKB</span> · epoch{" "}
              {receipt.epoch.toString()} ·{" "}
              {new Date(receipt.timestamp).toLocaleString()}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        {state.kind === "loading" ? (
          <div className="verify-banner">Fetching the decision record…</div>
        ) : state.kind === "verified" ? (
          <div className="verify-banner ok">
            ✓ Hash verified in your browser — keccak-256 of this record matches the
            on-chain commitment. This is what the agent was thinking.
          </div>
        ) : state.kind === "mismatch" ? (
          <div className="verify-banner bad">
            ⚠ VERIFICATION FAILED — the published record does NOT match the
            on-chain hash. Do not trust this record.
          </div>
        ) : state.kind === "not-published" ? (
          <div className="verify-banner warn">
            The operator has not published this decision record. The hash below
            still binds them: any record they produce later must match it.
          </div>
        ) : state.kind === "no-ledger" ? (
          <div className="verify-banner warn">
            No decision ledger is configured for this deployment — only the
            on-chain hash is available.
          </div>
        ) : (
          <div className="verify-banner warn">Ledger unreachable: {state.message}</div>
        )}

        {state.kind === "verified" ? (
          <div className="record">
            {"action" in state.record ? (
              <div className="record-row">
                <span className="k">Action</span>
                <span>{String(state.record.action)}</span>
              </div>
            ) : null}
            {"rationale" in state.record ? (
              <div className="record-row">
                <span className="k">Rationale</span>
                <span>{String(state.record.rationale)}</span>
              </div>
            ) : null}
            {"model" in state.record && state.record.model ? (
              <div className="record-row">
                <span className="k">Model</span>
                <span>{String(state.record.model)}</span>
              </div>
            ) : null}
            {"timestamp" in state.record ? (
              <div className="record-row">
                <span className="k">Decided at</span>
                <span>{String(state.record.timestamp)}</span>
              </div>
            ) : null}
            {"inputs" in state.record && state.record.inputs ? (
              <pre className="record-json">
                {JSON.stringify(state.record.inputs, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : null}

        <div className="modal-foot">
          <span className="addr" title={receipt.metaHash}>
            metaHash {receipt.metaHash}
          </span>
          {url ? (
            <a className="tx-link" href={url} target="_blank" rel="noreferrer">
              transaction on OKLink ↗
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
