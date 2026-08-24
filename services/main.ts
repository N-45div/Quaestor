import express from "express";
import { ethers } from "ethers";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { mountOracle, oracleConfigFromEnv } from "./oracle";
import { mountLedger } from "./ledger";
import { startIndexer } from "./indexer";
import { guardianConfigFromEnv, startGuardian } from "./guardian";
import { starterConfigFromEnv, mountStarter } from "./starter";
import { mountX402Lane } from "./x402lane";
import { mountDiscovery } from "./discovery";
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
// The service must outlive RPC flakiness: a stray rejection from a provider
// timer must degrade one tick, never kill the process.
process.on("unhandledRejection", (err) => {
  console.error("[main] unhandled rejection:", ((err as Error)?.message ?? String(err)).slice(0, 200));
});
process.on("uncaughtException", (err) => {
  console.error("[main] uncaught exception:", (err?.message ?? String(err)).slice(0, 200));
});

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

  const oracleCfg = oracleConfigFromEnv(provider);
  const oracle = mountOracle(app, oracleCfg);
  mountLedger(app, path.join(process.cwd(), "runs", "ledger"));
  startIndexer(app, provider, oracleCfg.quaestorAddress);

  // Governed lane lives where the contract lives (testnet during the
  // hackathon); the x402 lane settles on X Layer mainnet as OKX.AI requires.
  const governorNetwork = process.env.GOVERNOR_NETWORK ?? "eip155:1952";
  const network = process.env.X402_NETWORK ?? "eip155:196";
  const x402Price = process.env.X402_PRICE ?? "$0.01";
  let x402Enabled = false;
  if (process.env.X402_ENABLED === "1") {
    x402Enabled = await mountX402Lane(app, {
      payTo: oracleCfg.collector,
      network,
      price: x402Price,
      signal: oracle.currentSignal,
    });
  } else {
    console.log("[x402] lane disabled (X402_ENABLED != 1)");
  }

  mountDiscovery(app, {
    baseUrl: process.env.SELF_URL ?? `http://localhost:${port}`,
    quaestorAddress: oracleCfg.quaestorAddress,
    network: governorNetwork,
    x402Network: network,
    priceOkb: process.env.ORACLE_PRICE_OKB ?? "0.001",
    collector: oracleCfg.collector,
    x402Enabled,
    x402Price,
  });

  const starterCfg = starterConfigFromEnv(provider, rpcUrl);
  if (starterCfg) mountStarter(app, starterCfg);
  else console.log("[starter] not mounted (no HEARTBEAT_OPERATOR_KEY)");

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
