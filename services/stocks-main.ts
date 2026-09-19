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
import { mountStocks, stockPlatformFromEnv } from "./stocks";
import { mountStocksMcp, stocksMcpFromEnv } from "./mcp-http";
import { mountSolanaPaymentLane, solanaPaymentLaneFromEnv } from "./x402solana";

dotenv.config();

// The service must outlive a flaky RPC or price source: a stray rejection
// costs one tick, never the process.
process.on("unhandledRejection", (err) => {
  console.error("[stocks-main] unhandled rejection:", ((err as Error)?.message ?? String(err)).slice(0, 200));
});
process.on("uncaughtException", (err) => {
  console.error("[stocks-main] uncaught exception:", (err?.message ?? String(err)).slice(0, 200));
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
  app.post("/v1/stocks/orders", rateLimit({ name: "order", windowMs: 60_000, limit: 12 }));

  const startedAt = new Date().toISOString();
  app.get("/healthz", (_req, res) => res.json({ ok: true, lane: "solana-stocks", startedAt, at: new Date().toISOString() }));

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
  if (solanaLane) {
    try {
      mountSolanaPaymentLane(app, solanaLane);
    } catch (error) {
      console.error(`[solana-x402] lane not mounted, price tape served free: ${(error as Error).message}`);
    }
  }
  mountStocks(app, platform);

  const mcp = stocksMcpFromEnv(port);
  if (mcp) mountStocksMcp(app, mcp);

  app.get("/", (_req, res) => res.json({
    service: "quaestor-stocks",
    what: "An on-chain governor for AI agents trading tokenized stocks on Solana.",
    discovery: "/v1/stocks",
    mcp: mcp ? `${mcp.path ?? "/mcp"} (Streamable HTTP; present the agent key as Authorization: Bearer or X-API-Key)` : "not mounted",
    source: "https://github.com/N-45div/Quaestor",
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
