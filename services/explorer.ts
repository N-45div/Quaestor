import type { Express } from "express";
import { ethers } from "ethers";
import * as fs from "node:fs";
import * as path from "node:path";
import { startIndexer } from "./indexer";

/** Public, chain-scoped reads. No signing keys or transaction submission. */
export function mountExplorer(app: Express, includeHome = true) {
  // Which chains this host indexes. Every one is a poller against a public RPC,
  // so a host serving Base mainnet need not also walk four testnets.
  const all = ["base", "xlayerTestnet", "arcTestnet", "baseSepolia", "sepolia"];
  const wanted = (process.env.EXPLORER_CHAINS ?? all.join(",")).split(",").map(k => k.trim()).filter(Boolean);
  const keys = all.filter(k => wanted.includes(k));
  const configs = keys.map(key => ({ key, ...JSON.parse(fs.readFileSync(path.join(__dirname, "../app/public", key === "xlayerTestnet" ? "config.json" : `config.${key}.json`), "utf8")) }));
  const stops = configs.filter(c => includeHome || c.key !== "xlayerTestnet").map(c => {
    const req = new ethers.FetchRequest(c.rpcUrl);
    req.timeout = 12_000;
    const provider = new ethers.JsonRpcProvider(req, c.chainId, { staticNetwork: true });
    // Every 5 s suited X Layer. On a public endpoint that rate-limits per IP it
    // spends the budget the agent and the oracle share, so a host can slow it.
    return startIndexer(app, provider, c.contracts.Quaestor, Number(process.env.EXPLORER_POLL_MS ?? 5_000), {
      chainId: c.chainId, route: `/v1/explorer/${c.key}/receipts`, startBlock: c.startBlock,
      // The home chain also answers the legacy /receipts the MCP server and the
      // dashboard fallback still read.
      aliases: c.key === "xlayerTestnet" ? ["/receipts"] : [],
      range: c.key === "xlayerTestnet" ? 90 : 2000,
      dataDir: process.env.INDEXER_DATA_DIR ?? path.join(process.cwd(), "runs", "indexer"),
      governorVersion: c.governorVersion === 2 ? 2 : 1,
    });
  });
  app.get("/v1/explorer/networks", (_req, res) => res.json({ networks: configs.map(c => ({ key: c.key, chainId: c.chainId, governor: c.contracts.Quaestor, symbol: c.symbol, label: c.label, mainnet: Boolean(c.mainnet), governorVersion: c.governorVersion ?? 1 })) }));
  return { stop: () => stops.forEach(s => s.stop()) };
}
