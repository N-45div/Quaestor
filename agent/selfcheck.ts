import { ethers } from "ethers";
import type { BudgetSource, SpendShape } from "../services/graph";

/**
 * Cato asking whether a spend is unusual *for itself*, before proposing it.
 *
 * The governor's caps are the hard wall and they do not need help. This is a
 * different question: the caps say what the owner permitted in general, and
 * say nothing about whether this particular payment looks like anything this
 * agent has ever done. A sized buy that is 8× the largest payment in the
 * agent's history is inside the per-call cap right up until it isn't, and the
 * cap cannot tell the difference.
 *
 * That gap is exactly where a hallucinating or prompt-injected sizing step
 * lands: it cannot exceed the cap, so it sizes to the cap. The check below is
 * what notices.
 *
 * It is deliberately NOT a second enforcement layer. The chain refuses; this
 * only decides whether to ask.
 */

export interface Assessment {
  ok: boolean;
  /** Always populated — the log line explaining what was or was not checked. */
  reason: string;
  /** False when no source could see the agent's history at all. */
  checked: boolean;
  shape?: SpendShape;
}

export interface SelfCheckOptions {
  budgets: BudgetSource | null;
  /** The governor this agent actually spends through. */
  governor: string;
  agentId: string | number | bigint;
  category: number;
  amountWei: bigint;
  /** A spend may be this multiple of the largest the agent has ever made. */
  burstMultiple?: number;
}

/**
 * Returns ok:false only when history exists AND this spend breaks it. No
 * history, no source, or a stale index all return ok:true with `checked:false`
 * — the agent proceeds and the chain still enforces the caps.
 *
 * This is the opposite of the router's fail-closed rule in
 * /v1/policy/evaluate, and deliberately so. There, refusing costs a caller one
 * request and protects a budget it does not own. Here, refusing would strand a
 * live agent every time an indexer hiccups, and the thing it would be
 * protecting is already protected by the governor. Fail-closed is right when
 * you are the last line; it is wrong when you are the first of two.
 */
export async function assessSpend(opts: SelfCheckOptions): Promise<Assessment> {
  const { budgets, governor, agentId, category, amountWei } = opts;
  const burstX = opts.burstMultiple ?? 3;

  if (!budgets) {
    return { ok: true, checked: false, reason: "no budget source — caps only" };
  }

  // Agent #1 exists on every chain this contract is deployed to, each with its
  // own treasury and its own past. A history read from the wrong governor is
  // not a degraded answer, it is a confident wrong one — so refuse to use it.
  if (budgets.governor.toLowerCase() !== governor.toLowerCase()) {
    return {
      ok: true,
      checked: false,
      reason:
        `history source indexes ${budgets.governor} but this agent spends through ` +
        `${governor} — different governor, different past, so not consulted`,
    };
  }

  let shape: SpendShape | null = null;
  try {
    const budget = await budgets.budget(String(agentId), category);
    shape = budget.shape;
  } catch (err) {
    return {
      ok: true,
      checked: false,
      reason: `history unavailable (${(err as Error).message.slice(0, 90)}) — caps only`,
    };
  }

  if (!shape) {
    return { ok: true, checked: false, reason: "source cannot see spend shape — caps only" };
  }
  if (shape.maxPriorReceipt === 0n) {
    return {
      ok: true,
      checked: true,
      shape,
      reason: "no completed epoch on record yet — nothing to compare against",
    };
  }

  const ceiling = shape.maxPriorReceipt * BigInt(burstX);
  const ok = amountWei <= ceiling;
  return {
    ok,
    checked: true,
    shape,
    reason: ok
      ? `${ethers.formatEther(amountWei)} within ${burstX}× my largest ever ` +
        `${ethers.formatEther(shape.maxPriorReceipt)}`
      : `${ethers.formatEther(amountWei)} is more than ${burstX}× my largest ever spend ` +
        `${ethers.formatEther(shape.maxPriorReceipt)} — standing down rather than asking`,
  };
}
