/**
 * The governor Quaestor's house agent on Monad trades through. The deployer owns it; its operator
 * is the agent's Dynamic MPC wallet, so the only key that can trade is one no single machine holds
 * whole. It may spend 3 tUSDC a trade and 10 a day, on the five stocks Quaestor lists on Kuru, at
 * no more than 15% over Chainlink's price for each, and its fills at most 1% over Chainlink with a
 * price no older than 72 hours.
 *
 *   AGENT=0x… [DEPOSIT=30] npx hardhat run scripts/monad-agent-governor.ts --network monadTestnet
 */
import { ethers } from "hardhat";
import * as fs from "node:fs";
import { MONAD_TESTNET, chargedFees, label16, oraclePrice } from "../sdk/evm-stocks";

const usd = (x: number) => BigInt(Math.round(x * 1e6));

async function main() {
  const agent = process.env.AGENT;
  if (!agent || !ethers.isAddress(agent)) throw new Error("set AGENT to the agent's Dynamic wallet address");
  const row = MONAD_TESTNET;
  const [owner] = await ethers.getSigners();
  const fees = async () => chargedFees(ethers.provider);
  const deposit = usd(Number(process.env.DEPOSIT ?? 30));
  const budget = new ethers.Contract(row.budget.address, ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], owner);

  const held: bigint = await budget.balanceOf(owner.address);
  if (held < deposit) await (await budget.mint(owner.address, deposit - held, await fees())).wait();
  await (await budget.approve(row.factory, deposit, await fees())).wait();

  const instruments = row.instruments.filter((i) => i.feed);
  const prices = await Promise.all(instruments.map((i) => oraclePrice(ethers.provider, i.feed!, row.budget.decimals)));
  const factory = await ethers.getContractAt("QuaestorStocks", row.factory!, owner);
  const setup = {
    operator: agent,
    budgetToken: row.budget.address,
    epochLength: 86_400,
    perTradeCap: usd(3),
    epochCap: usd(10),
    venues: [row.venues[0].router],
    labels: [label16(row.venues[0].label)],
    tokens: instruments.map((i) => i.address),
    maxPrices: prices.map((p) => (p.price * 115n) / 100n),
    guards: instruments.map((i) => ({ token: i.address, feed: i.feed!, maxDeviationBps: 100, maxStaleness: 72 * 3600 })),
    deposit,
  };
  const gasLimit = ((await factory.createGovernor.estimateGas(setup)) * 115n) / 100n; // Monad charges the limit
  const receipt = (await (await factory.createGovernor(setup, { gasLimit, ...(await fees()) })).wait())!;
  const created = receipt.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "GovernorCreated");
  const governor: string = created!.args.governor;
  console.log(`agent governor ${governor} (tx ${receipt.hash}), operator ${agent}`);
  instruments.forEach((i, k) => console.log(`  ${i.symbol}: limit ${ethers.formatUnits(setup.maxPrices[k], 6)} (Chainlink ${ethers.formatUnits(prices[k].price, 6)})`));
  fs.writeFileSync("deployments/monad-agent-governor.json", JSON.stringify({ network: row.key, chainId: row.chainId, at: new Date().toISOString(), owner: owner.address, agent, governor, tx: receipt.hash, perTradeCap: "3", epochCap: "10", deposit: ethers.formatUnits(deposit, 6), stocks: instruments.map((i) => i.symbol) }, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
