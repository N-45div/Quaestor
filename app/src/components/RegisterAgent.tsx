import { useState } from "react";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { useStore } from "../state";

const EPOCHS = [
  { label: "5 minutes (demo pace)", value: 300 },
  { label: "1 hour", value: 3600 },
  { label: "1 day", value: 86400 },
  { label: "1 week", value: 604800 },
];

export function RegisterAgent({ onDone }: { onDone: () => void }) {
  const { cfg, registerAgent, account, notify } = useStore();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [operator, setOperator] = useState("");
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [epochLength, setEpochLength] = useState(86400);
  const [dep, setDep] = useState("0.1");
  const [caps, setCaps] = useState([
    { epochCap: "0.01", perCallCap: "0.002" }, // DATA
    { epochCap: "0.02", perCallCap: "0.005" }, // INFERENCE
    { epochCap: "0.05", perCallCap: "0.01" }, // EXECUTION
  ]);
  const [registeredId, setRegisteredId] = useState<bigint | null>(null);

  const setCap = (i: number, k: "epochCap" | "perCallCap", v: string) =>
    setCaps((prev) => prev.map((c, idx) => (idx === i ? { ...c, [k]: v } : c)));

  const generateKey = () => {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    setGeneratedKey(key);
    setOperator(address);
  };

  const envBlock =
    registeredId !== null && cfg
      ? [
          `RPC_URL=${cfg.rpcUrl}`,
          `QUAESTOR_ADDRESS=${cfg.contracts.Quaestor}`,
          `DEX_ADDRESS=${cfg.contracts.QuaestorDEX}`,
          `QUSD_ADDRESS=${cfg.contracts.qUSD}`,
          `AGENT_ID=${registeredId}`,
          `AGENT_NAME=${name || `agent-${registeredId}`}`,
          `OPERATOR_KEY=${generatedKey ?? "<your operator private key>"}`,
          ...(cfg.decisionLedgerUrl
            ? [
                `ORACLE_URL=${cfg.decisionLedgerUrl}`,
                `DECISION_LEDGER_URL=${cfg.decisionLedgerUrl}`,
              ]
            : []),
        ].join("\n")
      : "";

  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    notify(`${what} copied.`);
  };

  const submit = async () => {
    setErr(null);
    if (!account) return setErr("Connect a wallet first.");
    if (!name.trim()) return setErr("Give the agent a name.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(operator))
      return setErr("Operator must be a valid address — generate one or paste your own.");
    setBusy(true);
    try {
      const id = await registerAgent({
        name: name.trim(),
        operator: operator as Address,
        epochLength,
        deposit: dep,
        caps,
      });
      setRegisteredId(id);
    } catch (e) {
      const m = (e as Error).message;
      setErr(m.length > 160 ? `${m.slice(0, 160)}…` : m);
    } finally {
      setBusy(false);
    }
  };

  if (registeredId !== null) {
    return (
      <div className="form-card">
        <div className="success-head">
          ✓ Agent #{registeredId.toString()} is registered and funded.
        </div>
        <p className="success-sub">
          Point any agent at it — here is a ready-to-run environment. Keep the
          operator key with the agent, never with your own funds.
        </p>
        <pre className="env-block">{envBlock}</pre>
        <div className="form-actions">
          <button className="btn btn-gold btn-sm" onClick={() => void copy(envBlock, ".env")}>
            Copy .env
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void copy("npm run agent", "Command")}
          >
            Copy run command
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    );
  }

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
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={operator}
              onChange={(e) => {
                setOperator(e.target.value.trim());
                setGeneratedKey(null);
              }}
              placeholder="0x… (the agent's key, not yours)"
            />
            <button className="btn btn-ghost btn-sm" onClick={generateKey} type="button">
              Generate
            </button>
          </div>
          {generatedKey ? (
            <div className="keybox">
              <div className="keybox-warn">
                Operator private key — shown once, generated in your browser, never
                sent anywhere. Copy it now:
              </div>
              <div className="keybox-row">
                <code>{generatedKey}</code>
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  onClick={() => void copy(generatedKey, "Operator key")}
                >
                  Copy
                </button>
              </div>
            </div>
          ) : (
            <div className="note">
              The operator key can spend only through the governor — it is worthless
              anywhere else.
            </div>
          )}
        </div>
        <div className="field">
          <label>Budget epoch</label>
          <select value={epochLength} onChange={(e) => setEpochLength(Number(e.target.value))}>
            {EPOCHS.map((ep) => (
              <option key={ep.value} value={ep.value}>
                {ep.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Initial deposit ({cfg?.symbol ?? "native"})</label>
          <input value={dep} onChange={(e) => setDep(e.target.value)} inputMode="decimal" />
        </div>

        {(["Data", "Inference", "Execution"] as const).map((label, i) => (
          <div className="field" key={label} style={{ gridColumn: "1 / -1" }}>
            <label>{label} caps ({cfg?.symbol ?? "native"})</label>
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
