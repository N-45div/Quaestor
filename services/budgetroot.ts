import type { Express } from "express";
import { ethers } from "ethers";
import { ATTESTED_ABI, agentKeyOf } from "../sdk";

/**
 * The hub reads the budget root. A breach on Creditcoin — the sum of attested
 * spends across chains over the group's global cap — is a fact the hub shows
 * and acts on (it stops quoting that group's permits), never something the hub
 * decides. Read-only: no key, no writes.
 */

export interface BudgetRootOptions {
  rpcUrl: string;
  address: string;
  explorerAddr?: string;
}

export function mountBudgetRoot(app: Express, opts: BudgetRootOptions): void {
  const provider = new ethers.JsonRpcProvider(opts.rpcUrl);
  const root = new ethers.Contract(opts.address, ATTESTED_ABI, provider);
  const explorer = opts.explorerAddr ?? "https://creditcoin-testnet.blockscout.com/address/";

  app.get("/v1/budget/:groupId", async (req, res) => {
    const groupId = BigInt(String(req.params.groupId).replace(/\D/g, "") || "0");
    if (groupId === 0n) return res.status(400).json({ error: "groupId must be a positive integer" });
    try {
      const [g, spent, remaining, breached, epoch] = await Promise.all([
        root.groups(groupId),
        root.globalSpent(groupId),
        root.globalRemaining(groupId),
        root.isBreached(groupId),
        root.currentEpoch(groupId),
      ]);
      res.json({
        group: groupId.toString(),
        root: { address: opts.address, explorer: explorer + opts.address },
        cap: g.cap.toString(),
        cap_eth: ethers.formatEther(g.cap),
        epoch_length_s: Number(g.epochLength),
        epoch: epoch.toString(),
        spent: spent.toString(),
        spent_eth: ethers.formatEther(spent),
        remaining: remaining.toString(),
        remaining_eth: ethers.formatEther(remaining),
        breached,
        attested_spends: g.attestedSpends.toString(),
        note: breached
          ? "the sum of attested spends across chains exceeded the global cap; the hub is not quoting this group's permits until a human clears the breach"
          : "every spend counted here was proven through the Attestcoin precompile, not reported",
      });
    } catch (err) {
      res.status(502).json({ error: "budget root unreachable", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/v1/budget/:groupId/agent/:emitter/:agentId", async (req, res) => {
    try {
      const key = agentKeyOf(String(req.params.emitter), BigInt(String(req.params.agentId)));
      const [group, suspensions, chainKey] = await Promise.all([
        root.groupOf(key),
        root.suspensionsOf(key),
        root.chainKeyOf(String(req.params.emitter)),
      ]);
      res.json({
        emitter: req.params.emitter,
        agent_id: req.params.agentId,
        source_chain_key: chainKey.toString(),
        linked_group: group.toString(),
        attested_suspensions: suspensions.toString(),
      });
    } catch (err) {
      res.status(502).json({ error: "budget root unreachable", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  console.log(`[budget-root] mounted — GET /v1/budget/:groupId reads ${opts.address} on ${opts.rpcUrl}`);
}
