import express, { type Express } from "express";
import { ethers } from "ethers";
import * as fs from "node:fs";
import * as path from "node:path";
import { QUAESTOR_LOG_ABI } from "../sdk";

/**
 * Decision-record ledger: makes on-chain Receipts *openable*.
 *
 * An operator POSTs the exact JSON string whose keccak256 it committed
 * on-chain as `metaHash`. Anyone can GET the record by metaHash and recompute
 * the hash themselves — the dashboard does exactly that in the browser, so
 * trust in this service is never required, only availability.
 *
 *   POST /decisions        body: the raw decision JSON string  -> {metaHash}
 *   GET  /decisions/:hash  -> the exact stored string (text/plain)
 *
 * This host keeps no disk across deploys, so on its own it could only answer
 * for records published since it last started. With a `RecordSource`, a
 * record it does not hold is looked up where it was published durably — the
 * QuaestorLog contract, through the subgraph first and the chain's own logs
 * after — so a redeploy no longer makes old receipts unopenable.
 */

const MAX_RECORD_BYTES = 64 * 1024;

/** Somewhere durable a record may have been published. Answers with the text, or null. */
export interface RecordSource {
  name: string;
  find(metaHash: string): Promise<string | null>;
}

/**
 * The record's text, only if it hashes to what was asked for.
 *
 * Every source below is outside this process, and an indexer that answered
 * with the wrong bytes would otherwise put words in an agent's mouth. The
 * hash is the whole point of the design, so it is checked here, every time.
 */
function verified(metaHash: string, bytes: Uint8Array): string | null {
  return ethers.keccak256(bytes) === metaHash ? ethers.toUtf8String(bytes) : null;
}

/** QuaestorLog through the subgraph: one query, no block range to page through. */
export function subgraphRecordSource(url: string, fetchImpl: typeof fetch = fetch): RecordSource {
  return {
    name: "subgraph",
    async find(metaHash) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "query($id: Bytes!) { decisionRecord(id: $id) { recordBytes } }", variables: { id: metaHash } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`subgraph answered ${res.status}`);
      const body = (await res.json()) as { data?: { decisionRecord?: { recordBytes: string } | null } };
      const bytes = body.data?.decisionRecord?.recordBytes;
      return bytes ? verified(metaHash, ethers.getBytes(bytes)) : null;
    },
  };
}

/**
 * QuaestorLog through the chain itself: the event whose indexed metaHash is
 * the one asked for. It depends on nothing but the chain.
 *
 * Read in pages, newest first. Public endpoints refuse a wide range outright —
 * mainnet.base.org answers 413 from the log's first block to today — and a
 * record anyone looks up is almost always a recent one.
 */
export function chainRecordSource(provider: ethers.Provider, logAddress: string, fromBlock: number, pageBlocks = 10_000): RecordSource {
  const log = new ethers.Interface(QUAESTOR_LOG_ABI);
  const topic = log.getEvent("Published")!.topicHash;
  return {
    name: "chain",
    async find(metaHash) {
      let to = await provider.getBlockNumber();
      while (to >= fromBlock) {
        const from = Math.max(fromBlock, to - pageBlocks + 1);
        const logs = await provider.getLogs({ address: logAddress, topics: [topic, metaHash], fromBlock: from, toBlock: to });
        for (const entry of logs) {
          const parsed = log.parseLog(entry);
          const text = parsed ? verified(metaHash, ethers.getBytes(parsed.args.record)) : null;
          if (text !== null) return text;
        }
        to = from - 1;
      }
      return null;
    },
  };
}

/** `SUBGRAPH_URL` and `QUAESTOR_LOG_ADDRESS` from the environment, as sources in the order they are asked. */
export function recordSourcesFromEnv(provider: ethers.Provider): RecordSource[] {
  const sources: RecordSource[] = [];
  if (process.env.SUBGRAPH_URL) sources.push(subgraphRecordSource(process.env.SUBGRAPH_URL));
  if (process.env.QUAESTOR_LOG_ADDRESS) {
    // Log reads may go to an endpoint of their own, so a lookup does not spend
    // the rate limit the agent needs to trade with.
    const logs = process.env.QUAESTOR_LOG_RPC_URL ? new ethers.JsonRpcProvider(process.env.QUAESTOR_LOG_RPC_URL) : provider;
    sources.push(chainRecordSource(logs, process.env.QUAESTOR_LOG_ADDRESS, Number(process.env.QUAESTOR_LOG_FROM_BLOCK ?? 0)));
  }
  return sources;
}

export function mountLedger(app: Express, dataDir: string, sources: RecordSource[] = []): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const memory = new Map<string, string>();
  const retainedSince = new Date().toISOString();

  const fileOf = (metaHash: string) => path.join(dataDir, `${metaHash}.json`);

  const load = async (metaHash: string): Promise<{ raw: string; from: string } | null> => {
    const hit = memory.get(metaHash);
    if (hit !== undefined) return { raw: hit, from: "memory" };
    try {
      const raw = fs.readFileSync(fileOf(metaHash), "utf8");
      memory.set(metaHash, raw);
      return { raw, from: "disk" };
    } catch {
      // not on this host; ask the durable sources
    }
    for (const source of sources) {
      try {
        const raw = await source.find(metaHash);
        if (raw !== null) {
          memory.set(metaHash, raw);
          return { raw, from: source.name };
        }
      } catch (err) {
        console.error(`[ledger] ${source.name} lookup failed:`, (err as Error).message.slice(0, 160));
      }
    }
    return null;
  };

  app.post(
    "/decisions",
    express.text({ type: "*/*", limit: MAX_RECORD_BYTES }),
    (req, res) => {
      const raw = req.body;
      if (typeof raw !== "string" || !raw.length) {
        return res.status(400).json({ error: "empty body" });
      }
      try {
        JSON.parse(raw);
      } catch {
        return res.status(400).json({ error: "body must be a JSON string" });
      }
      const metaHash = ethers.keccak256(ethers.toUtf8Bytes(raw));
      if (!memory.has(metaHash)) {
        memory.set(metaHash, raw);
        try {
          fs.writeFileSync(fileOf(metaHash), raw);
        } catch (err) {
          console.error("[ledger] persist failed:", (err as Error).message);
        }
      }
      res.json({ metaHash });
    }
  );

  app.get("/decisions/:metaHash", async (req, res) => {
    const metaHash = req.params.metaHash.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(metaHash)) {
      return res.status(400).json({ error: "invalid metaHash" });
    }
    const found = await load(metaHash);
    if (found === null) {
      return res.status(404).json({
        error: "decision record not published",
        retainedSince,
        searched: ["memory", "disk", ...sources.map((s) => s.name)],
        note: sources.length
          ? "not held by this host since it last started, and not published to QuaestorLog; the on-chain hash still binds any record published later"
          : "records are kept since this host last started; the on-chain hash binds any record published later",
      });
    }
    // Where it came from, so a reader can tell a durable answer from a cached one.
    res.setHeader("x-record-source", found.from);
    res.type("text/plain").send(found.raw);
  });

  console.log(`[ledger] mounted — records in ${dataDir}${sources.length ? `, then ${sources.map((s) => s.name).join(", ")}` : ""}`);
}
