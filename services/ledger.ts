import express, { type Express } from "express";
import { ethers } from "ethers";
import * as fs from "node:fs";
import * as path from "node:path";

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
 */

const MAX_RECORD_BYTES = 64 * 1024;

export function mountLedger(app: Express, dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const memory = new Map<string, string>();
  // The host this runs on keeps no disk across deploys, so a record is only
  // retrievable if it was published since this process started. A 404 says
  // so, with the date, rather than letting "not published" read as "never".
  const retainedSince = new Date().toISOString();

  const fileOf = (metaHash: string) => path.join(dataDir, `${metaHash}.json`);

  const load = (metaHash: string): string | null => {
    const hit = memory.get(metaHash);
    if (hit !== undefined) return hit;
    try {
      const raw = fs.readFileSync(fileOf(metaHash), "utf8");
      memory.set(metaHash, raw);
      return raw;
    } catch {
      return null;
    }
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

  app.get("/decisions/:metaHash", (req, res) => {
    const metaHash = req.params.metaHash.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(metaHash)) {
      return res.status(400).json({ error: "invalid metaHash" });
    }
    const raw = load(metaHash);
    if (raw === null) {
      return res.status(404).json({
        error: "decision record not published",
        retainedSince,
        note: "records are kept since this host last started; the on-chain hash binds any record published later",
      });
    }
    res.type("text/plain").send(raw);
  });

  console.log(`[ledger] mounted — records in ${dataDir}`);
}
