import { ethers } from "ethers";
import * as dotenv from "dotenv";
import {
  createChainSource,
  createSubgraphSource,
  GraphError,
  type AgentBudget,
} from "../services/graph";

dotenv.config();

/**
 * Read one agent's budget from both sources and show the difference.
 *
 *   npx ts-node scripts/graph-check.ts [agentId] [category]
 *
 * The two columns should agree on caps and spend — the subgraph indexed the
 * same storage the governor holds, so a mismatch here is a real bug, not a
 * design tradeoff. The column that does not exist on the right is the point:
 * burst, frequency and the spend window come from the event stream or nowhere.
 *
 * Also prints how stale the subgraph is, because that number decides whether
 * the shape rules in /v1/policy/evaluate are allowed to vote at all.
 */
async function main() {
  const agentId = process.argv[2] ?? process.env.GOVERNED_AGENT_ID ?? "1";
  const category = Number(process.argv[3] ?? 0);

  const url = process.env.SUBGRAPH_URL;
  if (!url) throw new Error("SUBGRAPH_URL is required");
  const rpc = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
  const address = process.env.QUAESTOR_ADDRESS_BASE ?? process.env.QUAESTOR_ADDRESS;
  if (!address) throw new Error("QUAESTOR_ADDRESS (or QUAESTOR_ADDRESS_BASE) is required");

  const provider = new ethers.JsonRpcProvider(rpc);
  const subgraph = createSubgraphSource({
    url,
    governor: address,
    maxLagSeconds: Number(process.env.GRAPH_MAX_LAG_S ?? 120),
  });
  const chain = createChainSource(provider, address);

  console.log(`agent #${agentId}, category ${category}`);
  console.log(`  governor  ${address}`);
  console.log(`  subgraph  ${url}\n`);

  let indexed: AgentBudget | null = null;
  try {
    indexed = await subgraph.budget(agentId, category);
  } catch (err) {
    const e = err as GraphError;
    console.log(`subgraph REFUSED (${e.kind ?? "error"}): ${e.message}`);
    console.log("  → the shape rules cannot vote, so /v1/policy/evaluate denies\n");
  }

  const onchain = await chain.budget(agentId, category);
  const fmt = (v: bigint) => ethers.formatEther(v);

  const rows: Array<[string, string, string]> = [
    ["source", indexed ? indexed.source : "—", onchain.source],
    ["suspended", indexed ? String(indexed.suspended) : "—", String(onchain.suspended)],
    ["epochLength", indexed ? String(indexed.epochLength) : "—", String(onchain.epochLength)],
    ["currentEpoch", indexed ? indexed.currentEpoch : "—", onchain.currentEpoch],
    ["perCallCap", indexed ? fmt(indexed.perCallCap) : "—", fmt(onchain.perCallCap)],
    ["epochCap", indexed ? fmt(indexed.epochCap) : "—", fmt(onchain.epochCap)],
    ["spentThisEpoch", indexed ? fmt(indexed.spentThisEpoch) : "—", fmt(onchain.spentThisEpoch)],
    ["remaining", indexed ? fmt(indexed.remaining) : "—", fmt(onchain.remaining)],
  ];
  const w = Math.max(...rows.map((r) => r[1].length), 10);
  console.log(`${"".padEnd(16)}${"subgraph".padEnd(w + 3)}governor`);
  for (const [k, a, b] of rows) {
    // `source` is the label of the column, so it differs by construction.
    const flag = k !== "source" && a !== "—" && a !== b ? "  ← differs" : "";
    console.log(`${k.padEnd(16)}${a.padEnd(w + 3)}${b}${flag}`);
  }

  if (indexed?.head) {
    console.log(
      `\nindexed head  block ${indexed.head.block}, ${indexed.head.lagSeconds}s behind, ` +
        `indexingErrors=${indexed.head.hasIndexingErrors}`
    );
  }

  if (indexed?.shape) {
    const s = indexed.shape;
    console.log(`\nshape — no on-chain equivalent, this is the whole reason the subgraph exists`);
    console.log(`  epochs indexed        ${s.epochsSeen}${s.truncated ? " (TRUNCATED)" : ""}`);
    console.log(`  receipts this epoch   ${s.receiptCountThisEpoch}`);
    console.log(`  largest this epoch    ${fmt(s.maxReceiptThisEpoch)}`);
    console.log(`  largest ever (prior)  ${fmt(s.maxPriorReceipt)}`);
    console.log(`  busiest epoch (prior) ${s.maxPriorReceiptCount} receipts`);
    console.log(`  heaviest epoch(prior) ${fmt(s.maxPriorEpochSpend)}`);
    if (s.firstAtThisEpoch && s.lastAtThisEpoch) {
      const span = s.lastAtThisEpoch - s.firstAtThisEpoch;
      console.log(`  spend window          ${span}s`);
    }
    console.log(`\ngovernor equivalent   none of the above`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
