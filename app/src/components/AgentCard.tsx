import { useState } from "react";
import { useStore, type AgentView } from "../state";
import { agentName, okb, shortAddr, CATEGORY_NAMES, CATEGORY_KEYS } from "../lib/format";

export function AgentCard({ agent }: { agent: AgentView }) {
  const { account, suspend, resume, deposit, notify } = useStore();
  const [busy, setBusy] = useState(false);
  const isOwner = account && account.toLowerCase() === agent.owner.toLowerCase();

  const epochHours = agent.epochLength / 3600;
  const epochLabel =
    epochHours >= 24
      ? `${Math.round(epochHours / 24)}d epoch`
      : epochHours >= 1
        ? `${Math.round(epochHours)}h epoch`
        : `${Math.round(agent.epochLength / 60)}m epoch`;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify((e as Error).message.slice(0, 140));
    } finally {
      setBusy(false);
    }
  };

  const onDeposit = () => {
    const amount = window.prompt("Deposit how much OKB into this treasury?", "0.1");
    if (!amount) return;
    void act(() => deposit(agent.id, amount));
  };

  return (
    <div className="agent-card">
      <div className="head">
        <div>
          <div className="agent-name">{agentName(agent.id, agent.metadataURI)}</div>
          <div className="sub">
            #{agent.id.toString()} · operator {shortAddr(agent.operator)} · {epochLabel}
          </div>
        </div>
        {agent.suspended ? (
          <span className="badge badge-suspended">⏸ Suspended</span>
        ) : (
          <span className="badge badge-active">● Active</span>
        )}
      </div>

      <div className="treasury mono">
        {okb(agent.balance)} <small>OKB in treasury</small>
      </div>

      {agent.categories.map((c, i) => {
        const pct =
          c.cap === 0n ? 0 : Math.min(100, Number((c.spent * 100n) / c.cap));
        const exhausted = c.cap > 0n && c.spent >= c.cap;
        return (
          <div className={`meter ${exhausted ? "exhausted" : ""}`} key={i}>
            <div className="meter-label">
              <span className="name">
                <span className={`dot dot-${CATEGORY_KEYS[i]}`} /> {CATEGORY_NAMES[i]}
              </span>
              <span className="val mono">
                {okb(c.spent)} / {okb(c.cap)} OKB
                {exhausted ? " · exhausted" : ""}
              </span>
            </div>
            <div className="track">
              <div
                className={`fill fill-${CATEGORY_KEYS[i]}`}
                style={{ width: `${pct}%` }}
                title={`${CATEGORY_NAMES[i]}: ${okb(c.spent)} of ${okb(c.cap)} OKB spent this epoch (per-call cap ${okb(c.perCall)})`}
              />
            </div>
          </div>
        );
      })}

      <div className="actions">
        <button className="btn btn-ghost btn-sm" onClick={onDeposit} disabled={busy || !account}>
          Deposit
        </button>
        {isOwner ? (
          agent.suspended ? (
            <button
              className="btn btn-gold btn-sm"
              disabled={busy}
              onClick={() => void act(() => resume(agent.id))}
            >
              Resume
            </button>
          ) : (
            <button
              className="btn btn-danger btn-sm"
              disabled={busy}
              onClick={() => void act(() => suspend(agent.id))}
              title="Freeze all spending for this agent in one transaction"
            >
              ⏻ Kill-switch
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}
