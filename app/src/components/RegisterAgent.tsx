import { useState } from "react";
import type { Address } from "viem";
import { useStore } from "../state";

const EPOCHS = [
  { label: "5 minutes (demo pace)", value: 300 },
  { label: "1 hour", value: 3600 },
  { label: "1 day", value: 86400 },
  { label: "1 week", value: 604800 },
];

export function RegisterAgent({ onDone }: { onDone: () => void }) {
  const { registerAgent, account, notify } = useStore();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [operator, setOperator] = useState("");
  const [epochLength, setEpochLength] = useState(86400);
  const [dep, setDep] = useState("0.1");
  const [caps, setCaps] = useState([
    { epochCap: "0.01", perCallCap: "0.002" }, // DATA
    { epochCap: "0.02", perCallCap: "0.005" }, // INFERENCE
    { epochCap: "0.05", perCallCap: "0.01" }, // EXECUTION
  ]);

  const setCap = (i: number, k: "epochCap" | "perCallCap", v: string) =>
    setCaps((prev) => prev.map((c, idx) => (idx === i ? { ...c, [k]: v } : c)));

  const submit = async () => {
    setErr(null);
    if (!account) return setErr("Connect a wallet first.");
    if (!name.trim()) return setErr("Give the agent a name.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(operator))
      return setErr("Operator must be a valid address — use a fresh, disposable key.");
    setBusy(true);
    try {
      await registerAgent({
        name: name.trim(),
        operator: operator as Address,
        epochLength,
        deposit: dep,
        caps,
      });
      onDone();
    } catch (e) {
      const m = (e as Error).message;
      setErr(m.length > 160 ? `${m.slice(0, 160)}…` : m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-card">
      <div className="form-grid">
        <div className="field">
          <label>Agent name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Cato — my DCA agent"
            maxLength={48}
          />
        </div>
        <div className="field">
          <label>Operator address</label>
          <input
            value={operator}
            onChange={(e) => setOperator(e.target.value.trim())}
            placeholder="0x… (the agent's key, not yours)"
          />
          <div className="note">
            Generate a throwaway key for the agent. It can spend only through the
            governor.
          </div>
        </div>
        <div className="field">
          <label>Budget epoch</label>
          <select
            value={epochLength}
            onChange={(e) => setEpochLength(Number(e.target.value))}
          >
            {EPOCHS.map((ep) => (
              <option key={ep.value} value={ep.value}>
                {ep.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Initial deposit (OKB)</label>
          <input value={dep} onChange={(e) => setDep(e.target.value)} inputMode="decimal" />
        </div>

        {(["Data", "Inference", "Execution"] as const).map((label, i) => (
          <div className="field" key={label} style={{ gridColumn: "1 / -1" }}>
            <label>{label} caps (OKB)</label>
            <div style={{ display: "flex", gap: 12 }}>
              <input
                value={caps[i].epochCap}
                onChange={(e) => setCap(i, "epochCap", e.target.value)}
                inputMode="decimal"
                placeholder="per epoch"
                title={`${label}: maximum spend per epoch`}
              />
              <input
                value={caps[i].perCallCap}
                onChange={(e) => setCap(i, "perCallCap", e.target.value)}
                inputMode="decimal"
                placeholder="per action"
                title={`${label}: maximum spend per single action`}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="form-actions">
        <button className="btn btn-gold" onClick={() => void submit()} disabled={busy}>
          {busy ? "Registering…" : "Register agent"}
        </button>
        {err ? <span className="form-msg err">{err}</span> : null}
        {!err && !account ? (
          <span className="form-msg">Connect a wallet to register.</span>
        ) : null}
      </div>
    </div>
  );
}
