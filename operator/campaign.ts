/**
 * A campaign opened from the chat, with no wallet to connect: the Operator's own key (a Dynamic MPC wallet on Mezo)
 * opens a payout governor through the factory's createGovernorFor, naming the business's address as its owner. The
 * business then funds it with a plain transfer of the budget token to the governor's address, from anywhere.
 *
 * What each key can do is the contract's, not this module's: the owner alone withdraws, pauses and changes the limits;
 * the operator only escrows and releases deals to creators, inside the caps set here from the draft.
 */
import { ethers } from "ethers";
import { PAYOUTS_FACTORY_ABI, type Sender } from "./chain";
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

/** Open the governor for `owner`, signed by the lane's operator; the operator pays the gas and puts in nothing else. */
export async function openGovernorFor(
  lane: { network: OpNetwork; provider: ethers.Provider; sender: Sender }, owner: string, plan: CampaignPlan,
): Promise<{ governor: string; tx: string }> {
  const n = lane.network;
  if (!n.factory) throw new Error(`${n.name} has no payouts factory`);
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
  throw new Error(`the transaction ${tx} opened no governor`);
}
