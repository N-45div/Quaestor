import type { Express } from "express";
import { ethers } from "ethers";
import { QUAESTOR_ABI } from "../sdk";

/**
 * Receipt indexer: continuously scans Quaestor Receipt events server-side and
 * serves the recent history to the dashboard as JSON.
 *
 * Exists because X Layer's public RPC caps eth_getLogs at 100 blocks per
 * request — fine for an always-on incremental scanner, hopeless for a browser
 * that would need hundreds of requests to backfill. The dashboard fetches
 * GET /receipts instead and keeps direct RPC only for live state reads.
 */

export interface IndexedReceipt {
  txHash: string;
  blockNumber: number;
  timestamp: number; // ms
  agentId: string;
  category: number;
  payee: string;
  amount: string; // wei, decimal string
  metaHash: string;
  epoch: string;
  epochSpentAfter: string;
}

const MAX_RECEIPTS = 500;
const RANGE = 90n; // stay under the 100-block getLogs cap

export function startIndexer(
  app: Express,
  provider: ethers.JsonRpcProvider,
  quaestorAddress: string,
  pollMs = 8_000
): { stop: () => void } {
  const iface = new ethers.Interface(QUAESTOR_ABI);
  const receiptTopic = iface.getEvent("Receipt")!.topicHash;

  const receipts: IndexedReceipt[] = [];
  const blockTimes = new Map<number, number>();
  let nextFrom: bigint | null = null;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const head = BigInt(await provider.getBlockNumber());
      let from: bigint =
        nextFrom ?? (head - RANGE > 0n ? head - RANGE : 0n);
      while (from <= head) {
        const to: bigint = from + RANGE > head ? head : from + RANGE;
        const logs = await provider.getLogs({
          address: quaestorAddress,
          topics: [receiptTopic],
          fromBlock: from,
          toBlock: to,
        });
        for (const log of logs) {
          const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
          if (!parsed) continue;
          let ts = blockTimes.get(log.blockNumber);
          if (ts === undefined) {
            const block = await provider.getBlock(log.blockNumber);
            ts = Number(block?.timestamp ?? 0) * 1000;
            blockTimes.set(log.blockNumber, ts);
            if (blockTimes.size > 2000) {
              blockTimes.delete(blockTimes.keys().next().value as number);
            }
          }
          receipts.push({
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
            timestamp: ts,
            agentId: (parsed.args.agentId as bigint).toString(),
            category: Number(parsed.args.category),
            payee: parsed.args.payee as string,
            amount: (parsed.args.amount as bigint).toString(),
            metaHash: parsed.args.metaHash as string,
            epoch: (parsed.args.epoch as bigint).toString(),
            epochSpentAfter: (parsed.args.epochSpentAfter as bigint).toString(),
          });
        }
        if (receipts.length > MAX_RECEIPTS) {
          receipts.splice(0, receipts.length - MAX_RECEIPTS);
        }
        from = to + 1n;
        nextFrom = from;
      }
    } catch (err) {
      console.error("[indexer] tick failed:", (err as Error).message.slice(0, 160));
    } finally {
      busy = false;
    }
  };

  app.get("/receipts", (_req, res) => {
    res.json({ receipts: [...receipts].reverse() }); // newest first
  });

  void tick();
  const timer = setInterval(tick, pollMs);
  console.log(`[indexer] scanning ${quaestorAddress} in ≤${RANGE + 1n}-block windows`);
  return { stop: () => clearInterval(timer) };
}
