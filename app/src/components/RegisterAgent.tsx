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

/** Where an agent gets the command and the procedure it follows. */
export const AGENT_CLI_URL = "https://gitlab.com/ndivij2004/quaestor/-/raw/main/cli/dist/quaestor.mjs";
export const AGENT_SKILL_URL = "https://gitlab.com/ndivij2004/quaestor/-/tree/main/skills/quaestor-base";

/**
 * Starting values. On a testnet they are generous so a demo moves; on mainnet
 * they are real ETH, so they start where the house agent runs: a deposit of
 * 0.001 and caps that allow a few small trades a day. The owner can raise any
 * of them later from the agent's page.
 */
function defaultsFor(mainnet: boolean) {
  return mainnet
    ? {
        deposit: "0.001",
        caps: [
          { epochCap: "0.0001", perCallCap: "0.00002" }, // DATA
          { epochCap: "0.0001", perCallCap: "0.00002" }, // INFERENCE
          { epochCap: "0.0006", perCallCap: "0.0002" }, // EXECUTION
        ],
      }
    : {
        deposit: "0.1",
        caps: [
          { epochCap: "0.01", perCallCap: "0.002" },
          { epochCap: "0.02", perCallCap: "0.005" },
          { epochCap: "0.05", perCallCap: "0.01" },
        ],
      };
}

export function RegisterAgent({ onDone, initialOperator }: { onDone: () => void; initialOperator?: string }) {
  const { cfg, registerAgent, account, notify } = useStore();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const defaults = defaultsFor(Boolean(cfg?.mainnet));

  const [name, setName] = useState("");
  const [operator, setOperator] = useState(
    initialOperator && /^0x[0-9a-fA-F]{40}$/.test(initialOperator) ? initialOperator : "",
  );
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [epochLength, setEpochLength] = useState(86400);
  const [dep, setDep] = useState(defaults.deposit);
  const [caps, setCaps] = useState(defaults.caps);
  const [registeredId, setRegisteredId] = useState<bigint | null>(null);

  const setCap = (i: number, k: "epochCap" | "perCallCap", v: string) =>
    setCaps((prev) => prev.map((c, idx) => (idx === i ? { ...c, [k]: v } : c)));

  const generateKey = () => {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    setGeneratedKey(key);
    setOperator(address);
  };

  const v2 = cfg?.governorVersion === 2;
  const envBlock =
    registeredId !== null && cfg
      ? v2
        ? [
            // QuaestorV2: the agent runs one command and holds its own key.
            `curl -fsSLO ${AGENT_CLI_URL}`,
            ...(generatedKey ? [`export QUAESTOR_OPERATOR_KEY=${generatedKey}`] : []),
            `node quaestor.mjs status --agent ${registeredId}`,
            `node quaestor.mjs buy --agent ${registeredId} --eth 0.0001 --reason "<why this trade>"`,
          ].join("\n")
        : [
            `RPC_URL=${cfg.rpcUrl}`,
            `QUAESTOR_ADDRESS=${cfg.contracts.Quaestor}`,
            `DEX_ADDRESS=${cfg.contracts.QuaestorDEX}`,
            `QUSD_ADDRESS=${cfg.contracts.qUSD}`,
            `AGENT_ID=${registeredId}`,
            `AGENT_NAME=${name || `agent-${registeredId}`}`,
            `OPERATOR_KEY=${generatedKey ?? "<your operator private key>"}`,
            ...(cfg.decisionLedgerUrl
              ? [`ORACLE_URL=${cfg.decisionLedgerUrl}`, `DECISION_LEDGER_URL=${cfg.decisionLedgerUrl}`]
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
      return setErr("Operator must be a valid address: the one your agent's keygen printed, or generate one here.");
    if (operator.toLowerCase() === account.toLowerCase())
      return setErr("The operator must not be your own wallet: the agent's key would then also be the key that withdraws.");
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
          {v2
            ? `It can trade within the caps you set, and whatever it buys lands in your wallet. The operator pays its own gas: send about 0.0003 ${cfg?.symbol ?? "ETH"} to ${operator}. Then hand your agent these commands, or the skill.`
            : "Point any agent at it. Here is a ready-to-run environment. Keep the operator key with the agent, never with your own funds."}
        </p>
        <pre className="env-block">{envBlock}</pre>
        <div className="form-actions">
          <button className="btn btn-gold btn-sm" onClick={() => void copy(envBlock, v2 ? "Commands" : ".env")}>
            {v2 ? "Copy commands" : "Copy .env"}
          </button>
          {v2 ? (
            <a className="btn btn-ghost btn-sm" href={AGENT_SKILL_URL} target="_blank" rel="noreferrer">
              Open the agent skill
            </a>
          ) : (
            <button className="btn btn-ghost btn-sm" onClick={() => void copy("npm run agent", "Command")}>
              Copy run command
            </button>
          )}
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
          <label htmlFor="reg-name">Agent name</label>
          <input
            id="reg-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. my DCA agent"
            maxLength={48}
          />
        </div>
        <div className="field">
          <label htmlFor="reg-operator">Operator address</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              id="reg-operator"
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
                Operator private key, shown once, generated in your browser and never
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
              {initialOperator && operator === initialOperator
                ? "Filled in from your agent's link. Its key stays with the agent and can spend only through the governor."
                : "The operator key can spend only through the governor. It is worthless anywhere else."}
            </div>
          )}
        </div>
        <div className="field">
          <label htmlFor="reg-epoch">Budget epoch</label>
          <select id="reg-epoch" value={epochLength} onChange={(e) => setEpochLength(Number(e.target.value))}>
            {EPOCHS.map((ep) => (
              <option key={ep.value} value={ep.value}>
                {ep.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="reg-deposit">Initial deposit ({cfg?.symbol ?? "native"})</label>
          <input id="reg-deposit" value={dep} onChange={(e) => setDep(e.target.value)} inputMode="decimal" />
        </div>

        {(["Data", "Inference", "Execution"] as const).map((label, i) => (
          <div className="field" key={label} style={{ gridColumn: "1 / -1" }}>
            <label htmlFor={`reg-cap-${i}`}>{label} caps ({cfg?.symbol ?? "native"}): per epoch, per action</label>
            <div style={{ display: "flex", gap: 12 }}>
              <input
                id={`reg-cap-${i}`}
                aria-label={`${label} cap per epoch`}
                value={caps[i].epochCap}
                onChange={(e) => setCap(i, "epochCap", e.target.value)}
                inputMode="decimal"
                placeholder="per epoch"
                title={`${label}: maximum spend per epoch`}
              />
              <input
                aria-label={`${label} cap per action`}
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
        {!err && account && v2 && busy ? (
          <span className="form-msg">Your wallet asks for each step: register, three caps, the venue, the token.</span>
        ) : null}
      </div>
    </div>
  );
}
