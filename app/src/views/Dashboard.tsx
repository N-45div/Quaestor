import { useMemo, useState } from "react";
import { useStore } from "../state";
import { okb } from "../lib/format";
import { AgentCard } from "../components/AgentCard";
import { ReceiptFeed } from "../components/ReceiptFeed";
import { Watchdog } from "../components/Watchdog";
import { RegisterAgent } from "../components/RegisterAgent";
import { providerName } from "../lib/wallet";
import { shortAddr } from "../lib/format";

export function Dashboard() {
  const { cfg, ready, error, agents, receipts, account, connect, notify, toast, faucet } =
    useStore();
  const [showRegister, setShowRegister] = useState(false);

  const totals = useMemo(() => {
    const treasury = agents.reduce((acc, a) => acc + a.balance, 0n);
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const r24 = receipts.filter((r) => r.timestamp >= dayAgo);
    const spent24 = r24.reduce((acc, r) => acc + r.amount, 0n);
    return {
      treasury,
      agents: agents.length,
      suspended: agents.filter((a) => a.suspended).length,
      receipts24: r24.length,
      spent24,
    };
  }, [agents, receipts]);

  const onConnect = async () => {
    try {
      await connect();
    } catch (e) {
      notify((e as Error).message);
    }
  };

  return (
    <div>
      <div className="appbar">
        <div className="wrap inner">
          <div className="left">
            <a className="wordmark" href="#/">
              QU<span className="ae">Æ</span>STOR
            </a>
            <span className={`net-badge ${ready ? "live" : ""}`}>
              {cfg ? (cfg.chainId === 195 ? "X LAYER TESTNET" : cfg.network.toUpperCase()) : "…"}
              {ready ? " · LIVE" : ""}
            </span>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {cfg?.contracts.qUSD ? (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => faucet(cfg.contracts.qUSD).catch((e) => notify(e.message))}
                title="Claim free qUSD test tokens (1x per hour)"
              >
                qUSD faucet
              </button>
            ) : null}
            {account ? (
              <span className="net-badge">{shortAddr(account)}</span>
            ) : (
              <button className="btn btn-gold btn-sm" onClick={onConnect}>
                Connect {providerName()}
              </button>
            )}
          </div>
        </div>
      </div>

      <main className="wrap app-main">
        {error ? (
          <div className="empty-state" style={{ marginBottom: 28 }}>
            <div className="big">The treasury is unreachable.</div>
            <p>{error}</p>
          </div>
        ) : null}

        <div className="stat-row">
          <div className="stat">
            <div className="k">Agents under governance</div>
            <div className="v mono">{totals.agents}</div>
          </div>
          <div className="stat">
            <div className="k">OKB held in treasuries</div>
            <div className="v mono">
              {okb(totals.treasury)} <small>OKB</small>
            </div>
          </div>
          <div className="stat">
            <div className="k">Receipts · 24h</div>
            <div className="v mono">{totals.receipts24}</div>
          </div>
          <div className="stat">
            <div className="k">Governed spend · 24h</div>
            <div className="v mono">
              {okb(totals.spent24)} <small>OKB</small>
            </div>
          </div>
        </div>

        <div className="panel-title">
          <h2>Agents</h2>
          <button className="btn btn-gold btn-sm" onClick={() => setShowRegister((s) => !s)}>
            {showRegister ? "Close" : "Register an agent"}
          </button>
        </div>

        {showRegister ? (
          <div style={{ marginBottom: 24 }}>
            <RegisterAgent onDone={() => setShowRegister(false)} />
          </div>
        ) : null}

        {agents.length === 0 && ready ? (
          <div className="empty-state">
            <div className="big">No agents yet — the treasury awaits.</div>
            <p>
              Register the first agent: pick an operator key, set its allowance,
              and let it earn its keep.
            </p>
          </div>
        ) : (
          <div className="agent-grid">
            {agents.map((a) => (
              <AgentCard key={a.id.toString()} agent={a} />
            ))}
          </div>
        )}

        <div className="panel-title">
          <h2>Watchdog</h2>
          <span className="hint">
            deterministic checks over the receipt stream — plain English, no drama
          </span>
        </div>
        <Watchdog />

        <div className="panel-title">
          <h2>Receipts</h2>
          <span className="hint">every governed spend, newest first</span>
        </div>
        <ReceiptFeed />
      </main>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
