import express from "express";
import { ethers } from "ethers";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { mountOracle, oracleConfigFromEnv } from "./oracle";
import { mountLedger } from "./ledger";
import { guardianConfigFromEnv, startGuardian } from "./guardian";
import { runAgent } from "../agent";

dotenv.config();

/**
 * Single Render-deployable process for the whole Quaestor service plane:
 *   - paid oracle            (always)
 *   - decision-record ledger (always)
 *   - guardian watchdog      (when GUARDIAN_KEY is set)
 *   - the example governed agent Cato (when RUN_AGENT=1)
 *   - keepalive self-ping    (when KEEPALIVE_URL is set — survives free-tier sleep)
 */
async function main() {
  const rpcUrl =
    process.env.RPC_URL ?? process.env.XLAYER_TESTNET_RPC ?? "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const port = Number(process.env.PORT ?? process.env.ORACLE_PORT ?? 8402);

  const app = express();

  // The dashboard verifies records in the browser, so open CORS is safe here:
  // nothing this service serves is trusted — everything is re-hashed client-side.
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-quaestor-tx");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    next();
  });
  app.options("*", (_req, res) => res.sendStatus(204));

  app.get("/healthz", (_req, res) =>
    res.json({ ok: true, rpcUrl, at: new Date().toISOString() })
  );

  mountOracle(app, oracleConfigFromEnv(provider));
  mountLedger(app, path.join(process.cwd(), "runs", "ledger"));

  const guardianCfg = guardianConfigFromEnv(provider);
  if (guardianCfg) startGuardian(guardianCfg);
  else console.log("[guardian] not armed (no GUARDIAN_KEY)");

  if (process.env.RUN_AGENT === "1") {
    runAgent().catch((err) => console.error("[agent] crashed:", err));
  } else {
    console.log("[agent] not running here (RUN_AGENT != 1)");
  }

  if (process.env.KEEPALIVE_URL) {
    const url = process.env.KEEPALIVE_URL;
    setInterval(() => {
      fetch(url).catch(() => undefined);
    }, 10 * 60 * 1000);
    console.log(`[keepalive] pinging ${url} every 10m`);
  }

  app.listen(port, () => console.log(`[quaestor-services] listening on :${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
