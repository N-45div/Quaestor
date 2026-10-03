/**
 * The Chainlink CRE path for stock prices on Monad testnet: a QuaestorMirrorReceiver on CRE's
 * simulation forwarder, and a MirrorFeed per stock whose only relayer is that receiver, each
 * copying Chainlink's feed for the stock on Arbitrum One. The CRE workflow in
 * integrations/chainlink-cre/stock-mirror writes the prices; nothing else can.
 *
 *   npx hardhat run scripts/cre-mirror-monad.ts --network monadTestnet
 *
 * EVM_CRE_MONAD_TESTNET_KEY (the key the CRE CLI broadcasts simulated reports with) is read
 * from .env. It writes deployments/cre-mirror-monadTestnet.json.
 */
import { ethers, network } from "hardhat";
import * as fs from "node:fs";

// CRE's forwarders on Monad testnet (docs.chain.link/cre forwarder directory).
const SIMULATION_FORWARDER = "0xB9F79d863261869B234c481D1f9A7af84AeAd192";
const KEYSTONE_FORWARDER = "0xF8344CFd5c43616a4366C34E3EEE75af79a74482";
// Chainlink's stock feeds on Arbitrum One, 8 decimals (checked 3 Oct 2026).
const ARBITRUM_FEEDS: Record<string, string> = {
  NVDA: "0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F",
  SPY: "0x46306F3795342117721D8DEd50fbcF6DF2b3cc10",
  AAPL: "0x8d0CC5f38f9E802475f2CFf4F9fc7000C2E1557c",
};

async function main() {
  const [owner] = await ethers.getSigners();
  const log = (m: string) => console.log(`[${network.name}] ${m}`);
  const broadcaster = new ethers.Wallet(process.env.EVM_CRE_MONAD_TESTNET_KEY ?? "").address;
  log(`owner ${owner.address} ${ethers.formatEther(await ethers.provider.getBalance(owner.address))} MON, CRE broadcaster ${broadcaster}`);

  // The broadcaster pays for each simulated report it sends; Monad charges the whole gas limit.
  if ((await ethers.provider.getBalance(broadcaster)) < ethers.parseEther("0.1")) {
    await (await owner.sendTransaction({ to: broadcaster, value: ethers.parseEther("0.4"), gasLimit: 21_000n })).wait();
  }

  const receiver = await (await ethers.getContractFactory("QuaestorMirrorReceiver")).deploy(SIMULATION_FORWARDER, broadcaster);
  await receiver.waitForDeployment();
  const receiverAddress = await receiver.getAddress();
  log(`QuaestorMirrorReceiver ${receiverAddress} (simulation forwarder ${SIMULATION_FORWARDER}, sender ${broadcaster})`);

  const feeds: Record<string, { feed: string; source: string }> = {};
  for (const [sym, source] of Object.entries(ARBITRUM_FEEDS)) {
    const feed = await (await ethers.getContractFactory("MirrorFeed")).deploy(
      receiverAddress, 8, source, `${sym} / USD (Monad testnet mirror of Chainlink's Arbitrum One feed, written by a Chainlink CRE workflow)`,
    );
    await feed.waitForDeployment();
    const address = await feed.getAddress();
    await (await receiver.setFeed(ethers.encodeBytes32String(sym), address)).wait();
    feeds[sym] = { feed: address, source };
    log(`${sym} mirror ${address} <- Arbitrum One ${source}`);
  }

  const file = "deployments/cre-mirror-monadTestnet.json";
  fs.writeFileSync(file, `${JSON.stringify({
    network: network.name, chainId: Number((await ethers.provider.getNetwork()).chainId), at: new Date().toISOString(),
    receiver: receiverAddress, simulationForwarder: SIMULATION_FORWARDER, keystoneForwarder: KEYSTONE_FORWARDER, broadcaster, feeds,
  }, null, 2)}\n`);
  log(`wrote ${file}; owner has ${ethers.formatEther(await ethers.provider.getBalance(owner.address))} MON left`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
