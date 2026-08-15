import { useState } from "react";
import { useStore } from "../state";

interface SpendResult {
  what_just_happened?: string;
  the_point_exactly?: string;
  error?: string;
  receipt?: {
    tx: string;
    explorer: string;
    decision_hash: string;
    paid_okb: string;
  };
  budget_after?: { data_remaining_okb: string };
  verify_yourself?: string;
}

interface AgentResult {
  agent_id?: string;
  operator_address?: string;
  env?: string;
  run?: string;
  register_tx?: string;
  error?: string;
}

/** "Try it without a wallet" — real governed spends, no faucet, no extension. */
export function TryIt() {
  const { cfg, notify } = useStore();
  const base = cfg?.decisionLedgerUrl;
  const [busy, setBusy] = useState<"spend" | "agent" | null>(null);
  const [spend, setSpend] = useState<SpendResult | null>(null);
  const [agent, setAgent] = useState<AgentResult | null>(null);

  if (!base) return null;

  const runSpend = async () => {
    setBusy("spend");
    setSpend(null);
    try {
      const res = await fetch(`${base}/api/heartbeat`);
      setSpend((await res.json()) as SpendResult);
    } catch (e) {
      setSpend({ error: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const mintAgent = async () => {
    setBusy("agent");
    setAgent(null);
    try {
      const res = await fetch(`${base}/api/starter/claim`, { method: "POST" });
      setAgent((await res.json()) as AgentResult);
    } catch (e) {
      setAgent({ error: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const copyEnv = async () => {
    if (agent?.env) {
      await navigator.clipboard.writeText(agent.env);
      notify(".env copied.");
    }
  };

  return (
    <section className="section wrap" id="try">
      <div className="numeral">∅</div>
      <h2>Start here. Thirty seconds, no wallet.</h2>
      <p className="lede">
        X Layer&rsquo;s faucet wants an OKX account; you shouldn&rsquo;t need
        one to see this work. The heartbeat below is a <i>real</i> governed
        spend on X Layer testnet — our house agent, Pulse, pays the oracle
        through the governor inside caps its owner set, and hands you the
        receipt. It doubles as our uptime proof: if it beats, the whole stack
        is live.
      </p>

      <div style={{ display: "flex", gap: 14, marginTop: 28, flexWrap: "wrap" }}>
        <button className="btn btn-gold" onClick={runSpend} disabled={busy !== null}>
          {busy === "spend" ? "Beating…" : "Run the heartbeat"}
        </button>
        <button className="btn btn-ghost" onClick={mintAgent} disabled={busy !== null}>
          {busy === "agent" ? "Registering on-chain…" : "Claim a starter treasury"}
        </button>
      </div>

      {spend ? (
        <div className="try-result">
          {spend.receipt ? (
            <>
              <div className="try-line ok">
                ✓ {spend.what_just_happened}
              </div>
              <div className="try-line">
                Paid <b>{spend.receipt.paid_okb} OKB</b> · DATA budget left:{" "}
                <b>{spend.budget_after?.data_remaining_okb} OKB</b>
              </div>
              <div className="try-line">
                <a className="tx-link" href={spend.receipt.explorer} target="_blank" rel="noreferrer">
                  receipt on OKLink ↗
                </a>
                {"  ·  "}
                <a className="tx-link" href={spend.verify_yourself} target="_blank" rel="noreferrer">
                  the decision record it committed ↗
                </a>
              </div>
            </>
          ) : (
            <div className="try-line warn">
              {spend.the_point_exactly ?? spend.error}
            </div>
          )}
        </div>
      ) : null}

      {agent ? (
        <div className="try-result">
          {agent.env ? (
            <>
              <div className="try-line ok">
                ✓ Agent #{agent.agent_id} registered on-chain with a sponsored
                treasury — real caps, gas included. Outgrow it, register your
                own.
              </div>
              <pre className="env-block">{agent.env}</pre>
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button className="btn btn-gold btn-sm" onClick={() => void copyEnv()}>
                  Copy .env
                </button>
                <a
                  className="btn btn-ghost btn-sm"
                  href={agent.register_tx}
                  target="_blank"
                  rel="noreferrer"
                >
                  registration tx ↗
                </a>
              </div>
              <div className="try-line" style={{ marginTop: 10 }}>
                Then: <code style={{ fontSize: 12 }}>{agent.run}</code>
              </div>
            </>
          ) : (
            <div className="try-line warn">{agent.error}</div>
          )}
        </div>
      ) : null}

      <p className="lede" style={{ marginTop: 26, fontSize: 14 }}>
        Abuse protection here isn&rsquo;t a WAF — it&rsquo;s Quaestor. Pulse and
        every starter treasury run under on-chain caps; drain an epoch budget
        and the chain itself starts refusing. Making the governor say no is a
        feature, not an outage.
      </p>
    </section>
  );
}
