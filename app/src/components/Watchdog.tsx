import { useMemo, useState } from "react";
import { useStore, type AgentView, type ReceiptView } from "../state";
import { agentName, okb, CATEGORY_NAMES } from "../lib/format";

type Severity = "warning" | "serious" | "critical";

interface Flag {
  key: string;
  severity: Severity;
  icon: string;
  title: string;
  desc: string;
  agentId: bigint;
}

const SEVERITY_ICON: Record<Severity, string> = {
  warning: "⚠️",
  serious: "🔶",
  critical: "⛔",
};

/**
 * Deterministic checks over the receipt stream. No model in the loop for the
 * verdicts — the same ethos as the governor: the flag must be reproducible.
 */
function analyze(agents: AgentView[], receipts: ReceiptView[]): Flag[] {
  const flags: Flag[] = [];
  const now = Date.now();

  for (const agent of agents) {
    const name = agentName(agent.id, agent.metadataURI);
    const mine = receipts.filter((r) => r.agentId === agent.id);

    // 1. burst spending: many receipts inside one minute
    const lastMinute = mine.filter((r) => now - r.timestamp < 60_000);
    if (lastMinute.length >= 5) {
      flags.push({
        key: `burst-${agent.id}`,
        severity: "serious",
        icon: SEVERITY_ICON.serious,
        title: `${name} is spending in bursts`,
        desc: `${lastMinute.length} receipts in the last 60 seconds. Autonomous loops usually pace themselves; a burst can mean a retry storm or a compromised operator key.`,
        agentId: agent.id,
      });
    }

    // 2. pace: budget mostly gone while the epoch is young
    const elapsed =
      agent.epochLength > 0
        ? ((now / 1000 - agent.registeredAt) % agent.epochLength) / agent.epochLength
        : 0;
    agent.categories.forEach((c, i) => {
      if (c.cap === 0n) return;
      const usage = Number((c.spent * 100n) / c.cap) / 100;
      if (usage >= 1) {
        flags.push({
          key: `exhausted-${agent.id}-${i}`,
          severity: "warning",
          icon: SEVERITY_ICON.warning,
          title: `${name} exhausted its ${CATEGORY_NAMES[i]} budget`,
          desc: `The ${CATEGORY_NAMES[i].toLowerCase()} epoch cap of ${okb(c.cap)} OKB is fully spent. Further ${CATEGORY_NAMES[i].toLowerCase()} spends will revert until the epoch resets — by design.`,
          agentId: agent.id,
        });
      } else if (usage >= 0.8 && elapsed < 0.5) {
        flags.push({
          key: `pace-${agent.id}-${i}`,
          severity: "serious",
          icon: SEVERITY_ICON.serious,
          title: `${name} is burning ${CATEGORY_NAMES[i]} budget early`,
          desc: `${Math.round(usage * 100)}% of the ${CATEGORY_NAMES[i].toLowerCase()} cap is gone with ${Math.round((1 - elapsed) * 100)}% of the epoch still to run. If this pace is intentional, raise the cap; if not, consider the kill-switch.`,
          agentId: agent.id,
        });
      }
    });

    // 3. hammering the per-call ceiling
    agent.categories.forEach((c, i) => {
      if (c.perCall === 0n) return;
      const maxed = mine.filter(
        (r) => r.category === i && r.amount === c.perCall && r.epoch === agent.epoch
      );
      if (maxed.length >= 3) {
        flags.push({
          key: `ceiling-${agent.id}-${i}`,
          severity: "warning",
          icon: SEVERITY_ICON.warning,
          title: `${name} keeps maxing its ${CATEGORY_NAMES[i]} per-call cap`,
          desc: `${maxed.length} spends this epoch at exactly the ${okb(c.perCall)} OKB ceiling. Agents that always spend the maximum are probing the fence, not grazing.`,
          agentId: agent.id,
        });
      }
    });
  }

  const order: Severity[] = ["critical", "serious", "warning"];
  return flags.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
}

export function Watchdog() {
  const { agents, receipts, account, suspend, notify } = useStore();
  const [busy, setBusy] = useState(false);
  const flags = useMemo(() => analyze(agents, receipts), [agents, receipts]);

  if (!flags.length) {
    return (
      <div className="watchdog-empty">
        All quiet. Every agent is spending inside its lane.
      </div>
    );
  }

  const onKill = async (agentId: bigint) => {
    setBusy(true);
    try {
      await suspend(agentId);
    } catch (e) {
      notify((e as Error).message.slice(0, 140));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {flags.map((f) => {
        const agent = agents.find((a) => a.id === f.agentId);
        const canKill =
          agent &&
          !agent.suspended &&
          account &&
          account.toLowerCase() === agent.owner.toLowerCase();
        return (
          <div className={`flag ${f.severity}`} key={f.key}>
            <div className="icon" aria-hidden="true">
              {f.icon}
            </div>
            <div className="body">
              <div className="title">{f.title}</div>
              <div className="desc">{f.desc}</div>
            </div>
            {canKill ? (
              <button
                className="btn btn-danger btn-sm"
                disabled={busy}
                onClick={() => void onKill(f.agentId)}
              >
                ⏻ Kill-switch
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
