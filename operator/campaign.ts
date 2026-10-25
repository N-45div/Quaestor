/**
 * A campaign opened from the chat, with no wallet to connect: the Operator's own key (a Dynamic MPC wallet on Mezo)
 * opens a payout governor through the factory's createGovernorFor, naming the business's address as its owner. The
 * business then funds it with a plain transfer of the budget token to the governor's address, from anywhere.
 *
 * What each key can do is the contract's, not this module's: the owner alone withdraws, pauses and changes the limits;
 * the operator only escrows and releases deals to creators, inside the caps set here from the draft.
 */
import { ethers } from "ethers";
import { PAYOUTS_FACTORY_ABI, PAYOUT_GOVERNOR_ABI, type Sender } from "./chain";
import type { OpNetwork } from "./networks";

export interface CampaignTask { kind: string; title: string; done_when: string; rate_min_usd: number; rate_max_usd: number; slots: number }

/** The governor's limits, in dollars, from the draft: one deal pays up to the highest rate, a week pays up to the whole budget. */
export interface CampaignPlan { budgetUsd: number; perDealUsd: number; periodUsd: number; newPayeeUsd: number; newPayeesPerPeriod: number; periodSeconds: number }

export function campaignPlan(tasks: CampaignTask[]): CampaignPlan {
  const top = Math.max(...tasks.map((t) => t.rate_max_usd));
  const total = tasks.reduce((x, t) => x + t.rate_max_usd * t.slots, 0);
  const slots = tasks.reduce((x, t) => x + t.slots, 0);
  return { budgetUsd: total, perDealUsd: top, periodUsd: total, newPayeeUsd: top, newPayeesPerPeriod: Math.max(1, slots), periodSeconds: 7 * 86_400 };
}

const factoryIface = new ethers.Interface(PAYOUTS_FACTORY_ABI as unknown as string[]);

/** Dollars to the token's own units. */
const units = (usd: number, decimals: number) => ethers.parseUnits(usd.toFixed(6), decimals);

type Lane = { network: OpNetwork; provider: ethers.Provider; sender: Sender };

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Open the governor for `owner`, signed by the lane's operator; the operator pays the gas and puts in nothing else.
 * Its address comes from the receipt's GovernorCreated, or, where the RPC has no receipt yet, from the factory's list
 * of the owner's governors.
 */
export async function openGovernorFor(lane: Lane, owner: string, plan: CampaignPlan): Promise<{ governor: string; tx: string }> {
  const n = lane.network;
  if (!n.factory) throw new Error(`${n.name} has no payouts factory`);
  const factory = new ethers.Contract(n.factory, PAYOUTS_FACTORY_ABI as unknown as string[], lane.provider);
  const before = new Set(((await factory.governorsOf(owner)) as string[]).map((g) => g.toLowerCase()));
  const setup = {
    operator: lane.sender.address, token: n.usdc, epochLength: plan.periodSeconds,
    perDealCap: units(plan.perDealUsd, n.tokenDecimals), epochCap: units(plan.periodUsd, n.tokenDecimals),
    newPayeeCap: units(plan.newPayeeUsd, n.tokenDecimals), newPayeesPerEpoch: plan.newPayeesPerPeriod,
    payees: [], payeeCaps: [], tokenMessenger: n.tokenMessenger ?? ethers.ZeroAddress, maxForwardFeeBps: n.tokenMessenger ? 1000 : 0, deposit: 0n,
  };
  const data = factoryIface.encodeFunctionData("createGovernorFor", [ethers.getAddress(owner), setup]);
  const gas = await lane.provider.estimateGas({ from: lane.sender.address, to: n.factory, data });
  const tx = await lane.sender.send(n.factory, data, (gas * 13n) / 10n);
  const receipt = await lane.provider.getTransactionReceipt(tx);
  for (const log of receipt?.logs ?? []) {
    try {
      const e = factoryIface.parseLog(log);
      if (e?.name === "GovernorCreated") return { governor: ethers.getAddress(e.args.governor as string), tx };
    } catch {
      // another contract's event
    }
  }
  for (let i = 0; i < 30; i++) {
    const fresh = ((await factory.governorsOf(owner)) as string[]).find((g) => !before.has(g.toLowerCase()));
    if (fresh) return { governor: ethers.getAddress(fresh), tx };
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`the transaction ${tx} landed, but no new governor for ${owner} shows yet`);
}

/**
 * A governor this lane's operator already opened for `owner` with exactly these limits, in the budget token, that no
 * project claims: what a try reported as failed but which landed. Only the owner's last few are looked at.
 */
export async function unclaimedGovernorFor(lane: Lane, owner: string, plan: CampaignPlan, claimed: (governor: string) => boolean): Promise<{ governor: string; tx: string } | null> {
  const n = lane.network;
  if (!n.factory) return null;
  const factory = new ethers.Contract(n.factory, PAYOUTS_FACTORY_ABI as unknown as string[], lane.provider);
  // A copy: ethers' Result, and its slices, are read-only, and reverse() works in place.
  const mine = [...((await factory.governorsOf(owner)) as string[])].slice(-3).reverse();
  for (const address of mine) {
    if (claimed(address)) continue;
    const g = new ethers.Contract(address, PAYOUT_GOVERNOR_ABI as unknown as string[], lane.provider);
    const [operator, token, perDeal, perPeriod] = await Promise.all([g.operator(), g.token(), g.perDealCap(), g.epochCap()]);
    if (sameAddress(operator, lane.sender.address) && sameAddress(token, n.usdc)
      && perDeal === units(plan.perDealUsd, n.tokenDecimals) && perPeriod === units(plan.periodUsd, n.tokenDecimals)) {
      return { governor: ethers.getAddress(address), tx: "" };
    }
  }
  return null;
}
