/**
 * The Solana stocks lane as a process of its own.
 *
 * `services/main.ts` is the whole Quaestor service plane — the EVM oracle, the
 * ledger, the guardian, the hub — and wants a dozen EVM secrets to boot. A
 * deployment that only governs tokenized-stock trades on Solana needs none of
 * them, and a host should not be handed keys for lanes it does not run. This
 * entry mounts the stocks lane, its HTTP MCP endpoint and (optionally) the
 * Solana x402 lane, and nothing else.
 *
 *   SOLANA_STOCKS_ENABLED=1 SOLANA_STOCKS_CLUSTER=devnet \
 *   STOCKS_MCP_ENABLED=1 STOCKS_MCP_API_KEY=... \
 *   npm run services:stocks
 */
import express from "express";
import * as dotenv from "dotenv";
import { mountServiceCors } from "./cors";
import { hardenApp, mountErrorHandlers, rateLimit } from "./hardening";
import { faucetFromEnv, mountFaucet } from "./faucet";
import { devnetRelayFromEnv, mountDevnetRelay } from "./devnet-relay";
import { mountStocks, stockPlatformFromEnv } from "./stocks";
import { mountStocksMcp, stocksMcpFromEnv } from "./mcp-http";
import { intelFromEnv, mountIntel } from "./intel";
import { mountSolanaPaymentLane, solanaPaymentLaneFromEnv } from "./x402solana";
import { evmStocksFromEnv, mountEvmStocks } from "./stocks-evm";
import { safeMessage } from "../stocks/redact";

dotenv.config();

// The service must outlive a flaky RPC or price source: a stray rejection
// costs one tick, never the process.
process.on("unhandledRejection", (err) => {
  console.error("[stocks-main] unhandled rejection:", safeMessage(err, 200));
});
process.on("uncaughtException", (err) => {
  console.error("[stocks-main] uncaught exception:", safeMessage(err, 200));
});

function main(): void {
  const port = Number(process.env.PORT ?? 8402);
  const app = express();
  hardenApp(app);
  mountServiceCors(app);

  // Everything under /v1/stocks is reachable without a credential, so it is
  // budgeted per client. Quoting is budgeted harder: it is the one anonymous
  // route that writes state. The MCP tools' own loopback calls are exempt —
  // they were counted once already, at /mcp.
  app.use("/v1/stocks", rateLimit({ name: "API", windowMs: 60_000, limit: 120 }));
  const writeBudget = rateLimit({ name: "quote", windowMs: 60_000, limit: 20 });
  app.post("/v1/stocks/quotes", writeBudget);
  app.post("/v1/stocks/policy/preview", writeBudget);
  app.post("/v1/stocks/quote-check", rateLimit({ name: "quote check", windowMs: 60_000, limit: 60 }));
  app.post("/v1/stocks/orders", rateLimit({ name: "order", windowMs: 60_000, limit: 12 }));
  // Each refusal costs the fee payer a network fee and a co-signature, so the
  // demonstration is budgeted per visitor and across all of them.
  app.post(
    "/v1/stocks/demo/refusal",
    rateLimit({ name: "refusal demo", windowMs: 10 * 60_000, limit: 4 }),
    rateLimit({ name: "refusal demo (everyone)", windowMs: 60 * 60_000, limit: 60, key: () => "everyone" }),
  );
  // The paid tools are budgeted too: an unpaid request costs a 402, which is
  // cheap, but cheap is not free. The payment proxy's budget is its own.
  app.use("/v1/intel", rateLimit({ name: "intel", windowMs: 60_000, limit: 60 }));
  app.use("/internal/intel", rateLimit({ name: "intel proxy", windowMs: 60_000, limit: 600 }));
  // The explorer's devnet reads, relayed to this hub's keyed RPC. A page load
  // is about fifteen reads and an open tab three every 20 s; what the relay
  // may spend upstream is budgeted inside it, in credits.
  // The EVM lane's reads each cost a handful of RPC calls; its refusals cost gas.
  app.use("/v1/evm", rateLimit({ name: "EVM API", windowMs: 60_000, limit: 120 }));
  app.post(
    "/v1/evm/:network/demo/refusal",
    rateLimit({ name: "EVM refusal demo", windowMs: 10 * 60_000, limit: 4 }),
    rateLimit({ name: "EVM refusal demo (everyone)", windowMs: 60 * 60_000, limit: 60, key: () => "everyone" }),
  );
  app.use("/v1/solana/devnet", rateLimit({ name: "devnet RPC", windowMs: 60_000, limit: 240 }));
  app.use("/v1/solana/devnet", rateLimit({ name: "devnet RPC (everyone)", windowMs: 60_000, limit: 3_000, key: () => "everyone" }));

  const startedAt = new Date().toISOString();
  app.get("/healthz", (_req, res) => res.json({ ok: true, lane: "solana-stocks", startedAt, at: new Date().toISOString() }));

  // Test USDC for new governors on devnet; only when a faucet key is configured.
  const faucet = faucetFromEnv();
  if (faucet) mountFaucet(app, faucet);

  // The explorer's Solana pages read devnet through this; only when a keyed RPC is configured.
  const relay = devnetRelayFromEnv();
  if (relay) mountDevnetRelay(app, relay);

  const platform = stockPlatformFromEnv();
  if (!platform) {
    // Nothing else lives here, so a lane that cannot mount is a failed deploy
    // and should look like one rather than serve an empty 200.
    console.error("[stocks-main] the stocks lane did not mount — see the message above");
    process.exit(1);
  }

  // The payment lane goes first: its middleware answers 402 for the routes it
  // charges. If it cannot mount, the price tape stays readable for free.
  const solanaLane = solanaPaymentLaneFromEnv();
  let intelPaid = false;
  if (solanaLane) {
    try {
      mountSolanaPaymentLane(app, solanaLane);
      intelPaid = (solanaLane.charge ?? []).includes("intel");
    } catch (error) {
      console.error(`[solana-x402] lane not mounted, price tape served free: ${safeMessage(error, 200)}`);
    }
  }
  mountStocks(app, platform);

  // After the payment lane, so the paywall is already in front of these routes.
  const intel = intelFromEnv(intelPaid);
  if (intel) mountIntel(app, platform, intel);

  // Stock Token governors on EVM chains (Robinhood Chain, Monad): only when networks are named.
  const evm = evmStocksFromEnv();
  if (evm) mountEvmStocks(app, evm);

  const mcp = stocksMcpFromEnv(port);
  if (mcp) mountStocksMcp(app, mcp);

  app.get("/", (_req, res) => res.json({
    service: "quaestor-stocks",
    what: "An on-chain governor for AI agents trading tokenized stocks on Solana.",
    discovery: "/v1/stocks",
    paid_tools: intel ? "/v1/intel" : "not mounted",
    mcp: mcp ? `${mcp.path ?? "/mcp"} (Streamable HTTP; present the agent key as Authorization: Bearer or X-API-Key)` : "not mounted",
    source: "https://gitlab.com/ndivij2004/quaestor",
  }));

  // A free instance sleeps without inbound traffic, and the price tape lives in
  // memory: waking cold means the gate refuses until the tape refills. A
  // self-ping keeps both awake.
  if (process.env.KEEPALIVE_URL) {
    const url = process.env.KEEPALIVE_URL;
    setInterval(() => void fetch(url).catch(() => undefined), 10 * 60 * 1000).unref?.();
    console.log(`[keepalive] pinging ${url} every 10m`);
  }

  mountErrorHandlers(app);

  const server = app.listen(port, () => console.log(`[stocks-main] listening on :${port}`));
  // A client that opens a connection and never finishes its request holds a
  // socket for as long as it likes unless something says otherwise.
  server.headersTimeout = 15_000;
  // Long enough for an execution that has to wait out a blockhash to learn
  // whether an ambiguous submission landed.
  server.requestTimeout = 150_000;
  server.keepAliveTimeout = 65_000;
}

main();
