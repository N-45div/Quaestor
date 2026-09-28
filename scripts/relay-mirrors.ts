/**
 * Copy Chainlink's mainnet prices into a testnet's MirrorFeeds once, the same
 * step the hub repeats every ten minutes. For a fresh deployment, before the
 * hub is running.
 *
 *   NETWORK=robinhood-testnet npx ts-node --transpile-only scripts/relay-mirrors.ts
 *
 * The relayer key comes from EVM_MIRROR_<NETWORK>_KEY in .env and is never printed.
 */
import "dotenv/config";
import { ethers } from "ethers";
import { NETWORKS } from "../sdk/evm-stocks";
import { relayMirrors } from "../services/stocks-evm";

async function main() {
  const key = process.env.NETWORK ?? "robinhood-testnet";
  const network = NETWORKS[key];
  if (!network) throw new Error(`unknown network ${key}`);
  const mirrorKey = process.env[`EVM_MIRROR_${key.toUpperCase().replace(/-/g, "_")}_KEY`];
  if (!mirrorKey) throw new Error("no relayer key in .env for this network");
  const provider = new ethers.JsonRpcProvider(network.rpcUrl, network.chainId, { staticNetwork: true });
  const mainnet = new ethers.JsonRpcProvider(NETWORKS.robinhood.rpcUrl, NETWORKS.robinhood.chainId, { staticNetwork: true });
  const moved = await relayMirrors({ network, provider, mirrorKey }, mainnet);
  for (const m of moved) console.log(`${m.stock}: ${Number(m.answer) / 1e8} ${m.tx ? `mirrored (${m.tx})` : "already current"}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
