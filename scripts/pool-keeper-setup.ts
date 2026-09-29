/**
 * Fund the hub's pool keeper on Robinhood Chain's testnet: gas, and half the
 * deployer's faucet stock of each kind, so it can sell into a pool that drifted
 * over its feed (it mints its own tUSDG to buy from one that drifted under).
 * Then one pass, to show where each pool stands against its feed.
 *
 *   npx hardhat run scripts/pool-keeper-setup.ts --network robinhoodTestnet
 *
 * The keeper's key is EVM_KEEPER_ROBINHOOD_TESTNET_KEY in .env, never printed.
 */
import { ethers } from "hardhat";
import { ERC20_ABI, ROBINHOOD_TESTNET } from "../sdk/evm-stocks";
import { PoolKeeper } from "../services/pool-keeper";

async function main() {
  const [deployer] = await ethers.getSigners();
  const key = process.env.EVM_KEEPER_ROBINHOOD_TESTNET_KEY;
  if (!key) throw new Error("EVM_KEEPER_ROBINHOOD_TESTNET_KEY is not in .env");
  const keeper = new ethers.Wallet(key, ethers.provider);
  const n = ROBINHOOD_TESTNET;
  console.log(`keeper ${keeper.address}`);

  if ((await ethers.provider.getBalance(keeper.address)) < ethers.parseEther("0.002")) {
    await (await deployer.sendTransaction({ to: keeper.address, value: ethers.parseEther("0.005") })).wait();
  }
  for (const inst of n.instruments) {
    const share = new ethers.Contract(inst.address, ERC20_ABI, deployer);
    const [mine, its]: bigint[] = await Promise.all([share.balanceOf(deployer.address), share.balanceOf(keeper.address)]);
    if (its < 10n ** 17n && mine > 0n) await (await share.transfer(keeper.address, mine / 2n)).wait();
    console.log(`${inst.symbol}: keeper holds ${ethers.formatEther(await share.balanceOf(keeper.address))}`);
  }
  console.log(`gas: ${ethers.formatEther(await ethers.provider.getBalance(keeper.address))} ETH`);

  const rows = await new PoolKeeper({ network: n, provider: ethers.provider, keeperKey: key }).tick();
  for (const r of rows) console.log(`${r.stock}: pool $${r.poolPrice}, feed $${r.feedPrice}, ${r.driftBps} bps${r.tx ? `, moved (${r.tx})` : ""}${r.note ? `, ${r.note}` : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
