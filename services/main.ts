import express from "express";
import { ethers } from "ethers";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { mountOracle, oracleConfigFromEnv } from "./oracle";
import { mountLedger } from "./ledger";
import { guardianConfigFromEnv, startGuardian } from "./guardian";
import { starterConfigFromEnv, mountStarter } from "./starter";
import { mountX402Lane } from "./x402lane";
import { mountHederaLane } from "./x402hedera";
import { MemoryThreatFeed } from "./threatfeed";
import { createPermitPricer } from "./permits";
import { mountHub, tenantKeysFromEnv } from "./hub";
import { mountBudgetRoot } from "./budgetroot";
import { attestConfigFromEnv, watchGovernor } from "./attest";
import { mountDiscovery } from "./discovery";
import { budgetSourceFromEnv } from "./graph";
import { runAgent } from "../agent";
import { mountExplorer } from "./explorer";

dotenv.config();

/**
 * Single Render-deployable process for the whole Quaestor service plane:
 *   - paid oracle            (always)
 *   - decision-record ledger (always)
 *   - guardian watchdog      (when GUARDIAN_KEY is set)
 *   - the example governed agent Cato (when RUN_AGENT=1)
 *   - the Attestcoin proof watcher (when ATTEST_WATCH_ENABLED=1)
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
  // The explorer runs one indexer per chain, the home chain included, and
  // serves /receipts from the same scanner. A second home scanner here used to
  // share its checkpoint file with that one and race it.
  mountExplorer(app);

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

  // The hub: a shared threat feed and one permit price function. A venue that
  // other tenants were attacked through costs more to route through — for
  // everyone, within seconds — and Quaestor never has to say "no": when the
  // premium exceeds the owner's on-chain per-call cap, the chain refuses.
  // The feed starts in memory; a durable, append-only feed replaces it
  // without the lane or the hub changing.
  const threatFeed = new MemoryThreatFeed();
  const pricer = createPermitPricer({
    feed: threatFeed,
    baseHbar: process.env.PERMIT_BASE_HBAR,
    k: Number(process.env.PERMIT_K ?? 1),
  });
  mountHub(app, { feed: threatFeed, pricer, tenantKeys: tenantKeysFromEnv(process.env.TENANT_KEYS) });

  // The budget root on Creditcoin: read-only. Present once the root is deployed.
  if (process.env.ATTESTED_ADDRESS) {
    mountBudgetRoot(app, {
      rpcUrl: process.env.CREDITCOIN_RPC ?? "https://rpc.cc3-testnet.creditcoin.network",
      address: process.env.ATTESTED_ADDRESS,
    });
  } else {
    console.log("[budget-root] not mounted (no ATTESTED_ADDRESS)");
  }

  // The proof watcher is deliberately opt-in. It needs a relayer key, but it
  // never needs the root owner: QuaestorAttested.execute() is permissionless,
  // and the proof itself is checked by Creditcoin's native verifier. Keeping
  // this separate from the owner key preserves the root's admin boundary.
  const attestCfg = attestConfigFromEnv();
  const attestGovernor = process.env.ATTEST_SOURCE_GOVERNOR;
  if (process.env.ATTEST_WATCH_ENABLED === "1" && attestCfg && attestGovernor) {
    const fromBlockRaw = Number(process.env.ATTEST_FROM_BLOCK ?? 0);
    console.log(
      `[attest] watcher enabled — ${attestGovernor} from ${fromBlockRaw || "head"} ` +
        `into ${attestCfg.attestedAddress}`
    );
    watchGovernor(attestCfg, attestGovernor, {
      fromBlock: fromBlockRaw || undefined,
      onResult: (result) =>
        console.log(
          `[attest] credited ${result.sourceTx} → ${result.creditcoinTx} ` +
            `(${result.spends.length} spend, ${result.suspensions.length} suspension)`
        ),
      onBreach: async (groupId) =>
        console.error(
          `[attest] global cap breached for group ${groupId}; ` +
            "guardian suspension remains an explicit owner/watchdog action"
        ),
    }).catch((err) => console.error("[attest] watcher stopped:", err));
  } else {
    console.log(
      `[attest] watcher disabled — set ATTEST_WATCH_ENABLED=1, ` +
        "ATTEST_SOURCE_GOVERNOR, ATTESTED_ADDRESS and a relayer key to enable"
    );
  }

  // Pay-per-decision lane: the hub's decisions sold one x402 request at a time,
  // settled in HBAR through the Blocky402 facilitator.
  // Where /v1/policy/evaluate reads the agent's real budget. The subgraph
  // answers; a direct governor call catches it when the subgraph cannot; and
  // the two rules that need spend *shape* refuse rather than guess.
  const budgets = budgetSourceFromEnv(
    process.env.BASE_SEPOLIA_RPC
      ? new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC)
      : provider,
    process.env.QUAESTOR_ADDRESS_BASE ?? oracleCfg.quaestorAddress
  );

  if (process.env.X402_HEDERA_ENABLED === "1") {
    await mountHederaLane(app, {
      payTo: process.env.HEDERA_PAYTO_ACCOUNT_ID ?? process.env.HEDERA_ACCOUNT_ID ?? "",
      facilitatorUrl: process.env.BLOCKY402_URL ?? "https://api.testnet.blocky402.com",
      feed: threatFeed,
      pricer,
      signal: oracle.currentSignal,
      budgets,
      defaultAgentId: process.env.GOVERNED_AGENT_ID ?? "1",
      burstMultiple: Number(process.env.GRAPH_BURST_MULTIPLE ?? 3),
      precedentMultiple: Number(process.env.GRAPH_PRECEDENT_MULTIPLE ?? 3),
    });
  } else {
    console.log("[hedera] lane disabled (X402_HEDERA_ENABLED != 1)");
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
