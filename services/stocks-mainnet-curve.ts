/**
 * The mainnet curve, watched from the stocks hub.
 *
 * The launch on mainnet is real: real USDC, real buyers, and whoever arrives in
 * its first seconds. Nothing here trades it or signs for it. The hub reads the
 * pool on a slow timer and serves what it saw beside the devnet curve, judged
 * by the same rules, so one route answers for both.
 *
 * Reads `deployments/solana-mainnet.json`, which
 * `solana/scripts/dbc-devnet.ts --cluster mainnet` writes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection } from "@solana/web3.js";
import { MeteoraDbcPool } from "../stocks/dbc-venue";
import { DbcCurveWatcher } from "../stocks/dbc-watch";
import { safeMessage } from "../stocks/redact";

const PUBLIC_MAINNET = "https://api.mainnet-beta.solana.com";

/**
 * A mainnet RPC: the one named for it, else the devnet one's mainnet twin, else
 * the public endpoint. A provider that serves both clusters under one key at
 * hosts differing only in the cluster's name (Helius: `devnet.` and `mainnet.`)
 * is followed across; any other devnet URL is not guessed at.
 */
export function mainnetRpcUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SOLANA_MAINNET_RPC_URL) return env.SOLANA_MAINNET_RPC_URL;
  try {
    const url = new URL(env.SOLANA_DEVNET_RPC_URL ?? "");
    if (url.hostname.startsWith("devnet.")) {
      url.hostname = `mainnet.${url.hostname.slice("devnet.".length)}`;
      return url.toString();
    }
  } catch {
    // Unset or not a URL: the public endpoint.
  }
  return PUBLIC_MAINNET;
}

interface MainnetState {
  dbc?: {
    pool: string;
    baseMint: string;
    quoteMint: string;
    token: { symbol: string };
    anchored_to: { price_usd: number };
    plan: { band_bps: number; opening_price_usd: number; graduation_price_usd: number; graduation_usdc: number };
  };
}

/** The watcher, started, or nothing when no mainnet launch is on record or it is switched off. */
export function mainnetCurveFromEnv(): DbcCurveWatcher | null {
  if (process.env.SOLANA_STOCK_MAINNET_CURVE === "0") return null;
  const statePath = process.env.SOLANA_MAINNET_STATE ?? join(process.cwd(), "deployments", "solana-mainnet.json");
  if (!existsSync(statePath)) return null;
  let dbc: MainnetState["dbc"];
  let host: string;
  const rpcUrl = mainnetRpcUrl();
  try {
    dbc = (JSON.parse(readFileSync(statePath, "utf8")) as MainnetState).dbc;
    host = new URL(rpcUrl).hostname;
  } catch {
    // Not the error's own message: a malformed RPC URL would be quoted, key and all.
    console.error("[stocks] mainnet curve not watched — the deployment file or the mainnet RPC URL could not be parsed");
    return null;
  }
  if (!dbc) return null;

  // Never faster than a minute: nothing trades against it here.
  const everyMs = Math.max(60_000, Number(process.env.SOLANA_STOCK_MAINNET_CURVE_MS) || 300_000);
  let warnedAt = 0;
  const watcher = new DbcCurveWatcher({
    curve: {
      cluster: "mainnet",
      pool: dbc.pool,
      baseMint: dbc.baseMint,
      symbol: dbc.token.symbol,
      anchoredToUsd: dbc.anchored_to.price_usd,
      bandBps: dbc.plan.band_bps,
      openingPriceUsd: dbc.plan.opening_price_usd,
      graduationPriceUsd: dbc.plan.graduation_price_usd,
      graduationUsdc: dbc.plan.graduation_usdc,
    },
    pool: new MeteoraDbcPool(new Connection(rpcUrl, "confirmed"), { pool: dbc.pool, baseMint: dbc.baseMint, quoteMint: dbc.quoteMint }),
    everyMs,
    onError: (error) => {
      // An RPC that is down fails every pass; say so once an hour.
      if (Date.now() - warnedAt < 3_600_000) return;
      warnedAt = Date.now();
      console.warn(`[stocks] mainnet curve read failed: ${safeMessage(error, 160)}`);
    },
  });
  // The host only: a keyed RPC's URL carries the key.
  console.log(`[stocks] watching the mainnet curve — ${dbc.token.symbol} pool ${dbc.pool.slice(0, 6)}… through ${host}, every ${Math.round(everyMs / 60_000)} min`);
  return watcher.start();
}
