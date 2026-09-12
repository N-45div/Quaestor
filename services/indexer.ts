import type { Express } from "express";
import { ethers } from "ethers";
import { QUAESTOR_ABI } from "../sdk";
import * as fs from "node:fs";
import * as path from "node:path";

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
  logIndex?: number;
  chainId?: number;
  governor?: string;
}

const MAX_RECEIPTS = 5_000;
const RANGE = 90n; // stay under the 100-block getLogs cap

/**
 * How far back to reach on a cold start.
 *
 * This used to be one RANGE — 90 blocks. On X Layer's 2-second blocks that is a
 * **three minute** window, so a service that had been up for a week served six
 * receipts and looked like nothing had ever happened. The history was on chain
 * the whole time; nobody was asking for it.
 *
 * 43,200 blocks is 24h at 2s. At 90 per request that is ~480 calls, which takes
 * well under a minute once at boot and then never again.
 */
const BACKFILL = BigInt(process.env.INDEXER_BACKFILL_BLOCKS ?? 43_200);

export function startIndexer(
  app: Express,
  provider: ethers.JsonRpcProvider,
  quaestorAddress: string,
  pollMs = 8_000,
  options: { chainId?: number; route?: string; aliases?: string[]; startBlock?: number; range?: number; dataDir?: string } = {}
): { stop: () => void } {
  const iface = new ethers.Interface(QUAESTOR_ABI);
  const receiptTopic = iface.getEvent("Receipt")!.topicHash;

  let receipts: IndexedReceipt[] = [];
  const blockTimes = new Map<number, number>();
  let nextFrom: bigint | null = null;
  let busy = false;
  let historyTo: bigint | null = null;
  let indexedHead = 0;
  let checkedAt: string | null = null;
  let error: string | null = null;
  const range = BigInt(options.range ?? 90);
  const file = options.dataDir ? path.join(options.dataDir, `${options.chainId ?? 0}-${quaestorAddress.toLowerCase()}.json`) : null;
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved.governor === quaestorAddress.toLowerCase() && saved.chainId === options.chainId) {
        receipts = saved.receipts;
        nextFrom = BigInt(saved.nextFrom);
        historyTo = BigInt(saved.historyTo);
      }
    } catch { /* first boot or unreadable checkpoint: rebuild from chain */ }
  }

  const scan = async (from: bigint, to: bigint) => {
    const logs = await provider.getLogs({ address: quaestorAddress, topics: [receiptTopic], fromBlock: from, toBlock: to });
    const fresh: IndexedReceipt[] = [];
    for (const log of logs) {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      let ts = blockTimes.get(log.blockNumber);
      if (ts === undefined) {
        const block = await provider.getBlock(log.blockNumber);
        if (!block) throw new Error(`Block ${log.blockNumber} unavailable`);
        ts = Number(block.timestamp) * 1000;
        blockTimes.set(log.blockNumber, ts);
      }
      fresh.push({ txHash: log.transactionHash, logIndex: log.index, chainId: options.chainId,
        governor: quaestorAddress, blockNumber: log.blockNumber, timestamp: ts,
        agentId: String(parsed.args.agentId), category: Number(parsed.args.category),
        payee: parsed.args.payee, amount: String(parsed.args.amount), metaHash: parsed.args.metaHash,
        epoch: String(parsed.args.epoch), epochSpentAfter: String(parsed.args.epochSpentAfter) });
    }
    // Replace the rescanned range, including removed logs after a short reorg.
    receipts = mergeReceiptRange(receipts, fresh, Number(from), Number(to)).slice(-MAX_RECEIPTS);
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const head = BigInt(await provider.getBlockNumber());
      const floor = BigInt(options.startBlock ?? Number(head > BACKFILL ? head - BACKFILL : 0n));
      const recentFrom = head > range ? head - range : 0n;
      // Recent receipts are available after ONE request, regardless of history size.
      await scan(recentFrom, head);
      indexedHead = Number(head);
      checkedAt = new Date().toISOString();
      error = null;
      if (historyTo === null) historyTo = recentFrom - 1n;
      // Catch up a paused process without withholding the newest page.
      if (nextFrom !== null && nextFrom < recentFrom) {
        const to = nextFrom + range < recentFrom ? nextFrom + range : recentFrom - 1n;
        await scan(nextFrom, to);
        nextFrom = to + 1n;
      } else nextFrom = head + 1n;
      // Bounded work per tick; live polling never waits for the whole backfill.
      for (let page = 0; page < 4 && historyTo >= floor; page++) {
        const from: bigint = historyTo - range > floor ? historyTo - range : floor;
        await scan(from, historyTo);
        historyTo = from - 1n;
      }
      if (file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({ governor: quaestorAddress.toLowerCase(), chainId: options.chainId, receipts, nextFrom: String(nextFrom), historyTo: String(historyTo) }));
        fs.renameSync(`${file}.tmp`, file);
      }
    } catch (err) {
      error = (err as Error).message.slice(0, 160);
      console.error("[indexer] tick failed:", (err as Error).message.slice(0, 160));
    } finally {
      busy = false;
    }
  };

  const serve = (_req: unknown, res: { json: (body: unknown) => void }) => {
    res.json({ chainId: options.chainId, governor: quaestorAddress, receipts: [...receipts].reverse(),
      status: { indexedHead, checkedAt, error, historyComplete: historyTo !== null && options.startBlock !== undefined && historyTo < BigInt(options.startBlock), historyThrough: historyTo === null ? null : String(historyTo), retainedLimit: MAX_RECEIPTS } });
  };
  // One scanner can answer under several paths (the legacy /receipts and the
  // chain-scoped route) — two scanners for one chain would race on the same
  // checkpoint file and double the load on a rate-limited RPC.
  for (const route of [options.route ?? "/receipts", ...(options.aliases ?? [])]) app.get(route, serve);

  void tick();
  const timer = setInterval(tick, pollMs);
  console.log(`[indexer] scanning ${quaestorAddress} in ≤${range + 1n}-block windows`);
  return { stop: () => clearInterval(timer) };
}

export function mergeReceiptRange(previous: IndexedReceipt[], fresh: IndexedReceipt[], from: number, to: number): IndexedReceipt[] {
  const rows = previous.filter(r => r.blockNumber < from || r.blockNumber > to).concat(fresh);
  const unique = new Map(rows.map(r => [`${r.chainId}:${r.txHash}:${r.logIndex ?? r.metaHash}`, r]));
  return [...unique.values()].sort((a, b) => a.blockNumber - b.blockNumber || (a.logIndex ?? 0) - (b.logIndex ?? 0));
}
