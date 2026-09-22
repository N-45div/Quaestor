import { useState } from "react";
import { parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { RegistrationIncomplete, useStore } from "../state";

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

const MAX_UINT128 = (1n << 128n) - 1n;
const CAP_NAMES = ["Data", "Inference", "Execution"];

/**
 * Everything that can be wrong with the numbers, found before the first
 * wallet prompt. Found after it, the deposit would already be on chain in an
 * agent whose caps could not be set.
 */
export function registrationProblem(deposit: string, caps: { epochCap: string; perCallCap: string }[], mainnet: boolean): string | null {
  const amount = (label: string, raw: string): bigint | string => {
    try {
      const value = parseEther((raw || "0").trim());
      if (value < 0n) return `${label} cannot be negative.`;
      return value;
    } catch {
      return `${label} is not a number: write it like 0.001, with no commas or units.`;
    }
  };
  const dep = amount("The deposit", deposit);
  if (typeof dep === "string") return dep;
  if (mainnet && dep === 0n) return "Deposit something: an agent with an empty treasury cannot trade.";
  for (const [i, cap] of caps.entries()) {
    const epoch = amount(`The ${CAP_NAMES[i]} cap per epoch`, cap.epochCap);
    if (typeof epoch === "string") return epoch;
    const perCall = amount(`The ${CAP_NAMES[i]} cap per action`, cap.perCallCap);
    if (typeof perCall === "string") return perCall;
    if (epoch > MAX_UINT128 || perCall > MAX_UINT128) return `The ${CAP_NAMES[i]} caps are larger than the contract can hold.`;
    if (perCall > epoch) return `The ${CAP_NAMES[i]} cap per action is larger than its cap per epoch.`;
  }
  return null;
}

/** What an agent's link may fill in. Each value is checked by readLinkValues before it gets here. */
export interface LinkValues {
  name?: string;
  deposit?: string;
  epochLength?: number;
  caps?: { epochCap: string; perCallCap: string }[];
}

const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * The registration an agent proposed, from its link. A value that is not a
 * plain decimal, or an epoch the form does not offer, is dropped rather than
 * half-applied; the owner then sees the default in its place.
 */
export function readLinkValues(params: URLSearchParams): LinkValues {
  const out: LinkValues = {};
  const name = params.get("name")?.trim();
  if (name) out.name = name.slice(0, 48);
  const deposit = params.get("deposit")?.trim();
  if (deposit && DECIMAL.test(deposit)) out.deposit = deposit;
  const epoch = Number(params.get("epoch"));
  if (EPOCHS.some((e) => e.value === epoch)) out.epochLength = epoch;
  const caps = ["data", "inference", "execution"].map((key) => {
    const [epochCap, perCallCap] = (params.get(key) ?? "").split("/");
    return epochCap && perCallCap && DECIMAL.test(epochCap) && DECIMAL.test(perCallCap) ? { epochCap, perCallCap } : null;
  });
  if (caps.some(Boolean)) out.caps = caps.map((c) => c ?? { epochCap: "", perCallCap: "" });
  return out;
}

type Caps = { epochCap: string; perCallCap: string }[];

/**
 * What an agent's link set above the starting values, while the form still
 * shows what the link said. The agent writes the link and may have been
 * talked into it, so each of these is named for the owner to confirm.
 */
export function raisedByLink(
  initial: LinkValues,
  current: { deposit: string; epochLength: number; caps: Caps },
  defaults: { deposit: string; caps: Caps },
  symbol: string,
): string[] {
  const above = (value: string, usual: string) => {
    try { return parseEther(value) > parseEther(usual); } catch { return false; }
  };
  const out: string[] = [];
  if (initial.deposit && current.deposit === initial.deposit && above(initial.deposit, defaults.deposit)) {
    out.push(`a deposit of ${initial.deposit} ${symbol} (usually ${defaults.deposit})`);
  }
  CAP_NAMES.forEach((name, i) => {
    const link = initial.caps?.[i];
    const now = current.caps[i];
    const usual = defaults.caps[i];
    if (!link?.epochCap || now.epochCap !== link.epochCap || now.perCallCap !== link.perCallCap) return;
    if (above(link.epochCap, usual.epochCap) || above(link.perCallCap, usual.perCallCap)) {
      out.push(`${name} caps of ${link.epochCap} an epoch, ${link.perCallCap} an action (usually ${usual.epochCap}, ${usual.perCallCap})`);
    }
  });
  if (initial.epochLength !== undefined && current.epochLength === initial.epochLength && initial.epochLength < 86400) {
    out.push(`an epoch of ${EPOCHS.find((e) => e.value === initial.epochLength)?.label}, so the caps refill that often (usually 1 day)`);
  }
  return out;
}

export function RegisterAgent({ onDone, initialOperator, initial = {} }: { onDone: () => void; initialOperator?: string; initial?: LinkValues }) {
  const { cfg, registerAgent, finishSetup, account, notify } = useStore();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const defaults = defaultsFor(Boolean(cfg?.mainnet));

  const [name, setName] = useState(initial.name ?? "");
  const [operator, setOperator] = useState(
    initialOperator && /^0x[0-9a-fA-F]{40}$/.test(initialOperator) ? initialOperator : "",
  );
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [epochLength, setEpochLength] = useState(initial.epochLength ?? 86400);
  const [dep, setDep] = useState(initial.deposit ?? defaults.deposit);
  // A cap the link did not set keeps its default.
  const [caps, setCaps] = useState(defaults.caps.map((d, i) => (initial.caps?.[i]?.epochCap ? initial.caps[i] : d)));
  const proposed = Boolean(initial.name || initial.deposit || initial.epochLength || initial.caps);
  const [registeredId, setRegisteredId] = useState<bigint | null>(null);
  const [incomplete, setIncomplete] = useState<RegistrationIncomplete | null>(null);
  const [linkConfirmed, setLinkConfirmed] = useState(false);
  const [numbersConfirmed, setNumbersConfirmed] = useState(false);
  const mainnet = Boolean(cfg?.mainnet);
  const fromLink = Boolean(initialOperator) && operator === initialOperator;
  const raised = raisedByLink(initial, { deposit: dep, epochLength, caps }, defaults, cfg?.symbol ?? "ETH");

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
            `node quaestor.mjs buy --agent ${registeredId} --eth 0.0001 --reason "<why this trade>" --dry-run`,
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
    if (fromLink && !linkConfirmed)
      return setErr("Confirm that the operator address is the one your own agent printed.");
    if (raised.length && !numbersConfirmed)
      return setErr("Confirm the numbers the agent's link set above the usual ones, or change them.");
    const problem = registrationProblem(dep, caps, mainnet);
    if (problem) return setErr(problem);
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
      if (e instanceof RegistrationIncomplete) {
        setIncomplete(e);
      } else {
        const m = (e as Error).message;
        setErr(m.length > 160 ? `${m.slice(0, 160)}…` : m);
      }
    } finally {
      setBusy(false);
    }
  };

  /** Complete the steps a stopped setup left out; it re-reads the chain, so nothing is sent twice. */
  const resume = async () => {
    if (!incomplete) return;
    setErr(null);
    setBusy(true);
    try {
      await finishSetup(incomplete.agentId, caps);
      setRegisteredId(incomplete.agentId);
      setIncomplete(null);
    } catch (e) {
      const m = (e as Error).message;
      setErr(m.length > 160 ? `${m.slice(0, 160)}…` : m);
    } finally {
      setBusy(false);
    }
  };

  if (incomplete && registeredId === null) {
    return (
      <div className="form-card">
        <div className="success-head" style={{ color: "var(--gold)" }}>
          Agent #{incomplete.agentId.toString()} is registered, but its setup is not finished.
        </div>
        <p className="success-sub">
          It holds your deposit. What stopped it: {incomplete.cause}. Do not register again, which would create
          and fund a second agent. Finishing sends only the steps that are not on chain yet.
        </p>
        <div className="form-actions">
          <button className="btn btn-gold" onClick={() => void resume()} disabled={busy}>
            {busy ? "Finishing…" : "Finish setup"}
          </button>
          {err ? <span className="form-msg err">{err}</span> : null}
        </div>
      </div>
    );
  }

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
      {proposed ? (
        <div className="link-proposed">
          Your agent&rsquo;s link filled in the name, deposit and caps below. Check each one: they are what you sign.
          {raised.length ? (
            <label className="link-confirm">
              <input type="checkbox" checked={numbersConfirmed} onChange={(e) => setNumbersConfirmed(e.target.checked)} />
              <span>
                <strong className="link-raised">The link sets {raised.join("; ")}.</strong> These are the numbers I
                agreed with my agent.
              </span>
            </label>
          ) : null}
        </div>
      ) : null}
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
            {/* On mainnet the agent makes its own key; a key made in this page would
                have to be carried to the agent by hand, through places keys leak. */}
            {!mainnet ? (
              <button className="btn btn-ghost btn-sm" onClick={generateKey} type="button">
                Generate
              </button>
            ) : null}
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
            fromLink ? (
              <label className="note link-confirm">
                <input type="checkbox" checked={linkConfirmed} onChange={(e) => setLinkConfirmed(e.target.checked)} />
                <span>
                  Filled in from a link. Whoever holds this address&rsquo;s key can spend up to your caps every
                  epoch. It is the address my own agent printed (<code>node quaestor.mjs whoami</code>).
                </span>
              </label>
            ) : (
              <div className="note">
                Whoever holds the operator key can spend up to your caps and nothing more: trades land in your
                wallet, and payments for data or inference stay within those caps.
              </div>
            )
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
            <label htmlFor={`reg-cap-${i}`}>
              {label} caps ({cfg?.symbol ?? "native"}): per epoch, per action
              {/* Payments for data and inference go wherever the agent names; a
                  trade's output can only reach the owner's wallet. */}
              {i < 2 ? " · paid to any address your agent names" : " · what it buys lands in your wallet"}
            </label>
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
          <span className="form-msg">Your wallet asks once if it can batch the steps, otherwise once for each: register, three caps, the venue, the token.</span>
        ) : null}
      </div>
    </div>
  );
}
