import { useState } from "react";
import type { Address } from "viem";
import { useStore, type AgentView } from "../state";
import { agentName, okb, shortAddr, CATEGORY_NAMES, CATEGORY_KEYS } from "../lib/format";

const ZERO = "0x0000000000000000000000000000000000000000";

export function AgentCard({ agent }: { agent: AgentView }) {
  const { account, suspend, resume, deposit, withdraw, setPolicy, setGuardian, notify, cfg } =
    useStore();
  // The chain's own unit. On Arc this is USDC, so the caps below read as
  // dollars — the same contract, a different denomination.
  const SYM = cfg?.symbol ?? "";
  const [busy, setBusy] = useState(false);
  const [fundMode, setFundMode] = useState<"none" | "deposit" | "withdraw">("none");
  const [amount, setAmount] = useState("0.1");
  const [manage, setManage] = useState(false);
  const [caps, setCaps] = useState(
    agent.categories.map((c) => ({
      epochCap: (Number(c.cap) / 1e18).toString(),
      perCallCap: (Number(c.perCall) / 1e18).toString(),
    }))
  );
  const [guardianInput, setGuardianInput] = useState(
    agent.guardian === ZERO ? "" : agent.guardian
  );

  const isOwner = account && account.toLowerCase() === agent.owner.toLowerCase();
  const guarded = agent.guardian !== ZERO;

  const epochHours = agent.epochLength / 3600;
  let epochLabel: string;
  if (epochHours >= 24) epochLabel = `${Math.round(epochHours / 24)}d epoch`;
  else if (epochHours >= 1) epochLabel = `${Math.round(epochHours)}h epoch`;
  else epochLabel = `${Math.round(agent.epochLength / 60)}m epoch`;

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

  const submitFund = () => {
    if (!amount || Number.isNaN(Number(amount))) return notify("Enter a valid amount.");
    const mode = fundMode;
    setFundMode("none");
    void act(() =>
      mode === "deposit" ? deposit(agent.id, amount) : withdraw(agent.id, amount)
    );
  };

  const saveCaps = (i: number) =>
    void act(() => setPolicy(agent.id, i, caps[i].epochCap, caps[i].perCallCap));

  const saveGuardian = () => {
    const v = guardianInput.trim();
    if (v && !/^0x[0-9a-fA-F]{40}$/.test(v)) return notify("Guardian must be an address.");
    void act(() => setGuardian(agent.id, (v || ZERO) as Address));
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
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
          {agent.suspended ? (
            <span className="badge badge-suspended">⏸ Suspended</span>
          ) : (
            <span className="badge badge-active">● Active</span>
          )}
          {guarded ? (
            <span
              className="badge badge-guarded"
              title={`Guardian ${agent.guardian} can suspend this agent — and nothing else`}
            >
              🛡 Guarded
            </span>
          ) : null}
        </div>
      </div>

      <div className="treasury mono">
        {okb(agent.balance)} <small>{SYM} in treasury</small>
      </div>

      {agent.categories.map((c, i) => {
        const pct = c.cap === 0n ? 0 : Math.min(100, Number((c.spent * 100n) / c.cap));
        const exhausted = c.cap > 0n && c.spent >= c.cap;
        return (
          <div className={`meter ${exhausted ? "exhausted" : ""}`} key={CATEGORY_KEYS[i]}>
            <div className="meter-label">
              <span className="name">
                <span className={`dot dot-${CATEGORY_KEYS[i]}`} /> {CATEGORY_NAMES[i]}
              </span>
              <span className="val mono">
                {okb(c.spent)} / {okb(c.cap)} {SYM}
                {exhausted ? " · exhausted" : ""}
              </span>
            </div>
            <div className="track">
              <div
                className={`fill fill-${CATEGORY_KEYS[i]}`}
                style={{ width: `${pct}%` }}
                title={`${CATEGORY_NAMES[i]}: ${okb(c.spent)} of ${okb(c.cap)} ${SYM} spent this epoch (per-call cap ${okb(c.perCall)})`}
              />
            </div>
          </div>
        );
      })}

      {fundMode !== "none" ? (
        <div className="fund-row">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            autoFocus
            aria-label={`${fundMode} amount in ${SYM}`}
          />
          <button className="btn btn-gold btn-sm" disabled={busy} onClick={submitFund}>
            {fundMode === "deposit" ? "Deposit" : "Withdraw"} {SYM}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setFundMode("none")}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="actions">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setFundMode("deposit")}
            disabled={busy || !account}
          >
            Deposit
          </button>
          {isOwner ? (
            <>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setFundMode("withdraw")}
                disabled={busy}
              >
                Withdraw
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setManage((m) => !m)}
                disabled={busy}
              >
                {manage ? "Close" : "Manage"}
              </button>
              {agent.suspended ? (
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
              )}
            </>
          ) : null}
        </div>
      )}

      {manage && isOwner ? (
        <div className="manage-panel">
          {CATEGORY_NAMES.map((label, i) => (
            <div className="manage-row" key={label}>
              <span className="k">
                <span className={`dot dot-${CATEGORY_KEYS[i]}`} /> {label}
              </span>
              <input
                value={caps[i].epochCap}
                onChange={(e) =>
                  setCaps((p) => p.map((c, j) => (j === i ? { ...c, epochCap: e.target.value } : c)))
                }
                inputMode="decimal"
                title={`${label}: epoch cap in ${SYM}`}
              />
              <input
                value={caps[i].perCallCap}
                onChange={(e) =>
                  setCaps((p) =>
                    p.map((c, j) => (j === i ? { ...c, perCallCap: e.target.value } : c))
                  )
                }
                inputMode="decimal"
                title={`${label}: per-action cap in ${SYM}`}
              />
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => saveCaps(i)}>
                Save
              </button>
            </div>
          ))}
          <div className="manage-row">
            <span className="k">🛡 Guardian</span>
            <input
              value={guardianInput}
              onChange={(e) => setGuardianInput(e.target.value)}
              placeholder="0x… (empty to disarm)"
              style={{ gridColumn: "2 / 4" }}
              title="An address that can ONLY suspend this agent — never spend, withdraw, or resume"
            />
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={saveGuardian}>
              Set
            </button>
          </div>
          <div className="manage-note">
            Caps are per category: first field = per epoch, second = per action. The
            guardian can only pull the kill-switch — it can never spend or withdraw.
          </div>
        </div>
      ) : null}
    </div>
  );
}
