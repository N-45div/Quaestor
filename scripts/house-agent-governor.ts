/**
 * The governor a house trading agent trades through, on any network in sdk/evm-stocks.ts. The deployer owns it; its
 * operator is the agent's Dynamic MPC wallet, so the only key that can trade is one no single machine holds whole.
 * Caps are in the budget's own dollars, whatever its decimals (6 for USDC, 18 for MUSD). Each instrument's limit price
 * is its oracle price plus LIMIT_PCT where the chain has a feed, with fills held to 1% over the feed; where it has none,
 * the limit is the venue's fill now plus LIMIT_PCT, or LIMIT_USD_<SYMBOL> when given. The agent's gas goes with it.
 *
 *   NETWORK=mezo-testnet AGENT=0x… [DEPOSIT=60 PER_TRADE=5 PER_DAY=20 LIMIT_PCT=10] npx hardhat run scripts/house-agent-governor.ts --network mezoTestnet
 */
import { ethers } from "hardhat";
import * as fs from "node:fs";
import { NETWORKS, bestQuote, fillPrice, label16, oraclePrice } from "../sdk/evm-stocks";

async function main() {
  const row = NETWORKS[process.env.NETWORK ?? ""];
  const agent = process.env.AGENT;
  if (!row?.factory) throw new Error(`NETWORK must be a row with a factory: ${Object.keys(NETWORKS).join(", ")}`);
  if (!agent || !ethers.isAddress(agent)) throw new Error("set AGENT to the agent's Dynamic wallet address");
  const [owner] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  if (Number(chainId) !== row.chainId) throw new Error(`hardhat is on chain ${chainId}, the row is ${row.chainId}`);
  const dollars = (x: string) => ethers.parseUnits(x, row.budget.decimals);
  const deposit = dollars(process.env.DEPOSIT ?? "60");
  const perTrade = dollars(process.env.PER_TRADE ?? "5");
  const perDay = dollars(process.env.PER_DAY ?? "20");
  const limitPct = BigInt(process.env.LIMIT_PCT ?? "10");

  const budget = new ethers.Contract(row.budget.address, ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], owner);
  const held: bigint = await budget.balanceOf(owner.address);
  if (held < deposit) throw new Error(`the owner holds ${ethers.formatUnits(held, row.budget.decimals)} ${row.budget.symbol}; the deposit is ${ethers.formatUnits(deposit, row.budget.decimals)}`);

  const limits = await Promise.all(row.instruments.map(async (i) => {
    const fixed = process.env[`LIMIT_USD_${i.symbol.toUpperCase()}`];
    if (fixed) return { price: dollars(fixed), from: "fixed" };
    if (i.feed) return { price: ((await oraclePrice(ethers.provider, i.feed, row.budget.decimals)).price * (100n + limitPct)) / 100n, from: "oracle" };
    const probe = perTrade / 10n;
    const q = await bestQuote(ethers.provider, row, i, probe);
    return { price: (fillPrice(probe, q.amountOut, i.decimals) * (100n + limitPct)) / 100n, from: "fill" };
  }));
  const venue = row.venues[0];
  const setup = {
    operator: agent,
    budgetToken: row.budget.address,
    epochLength: 86_400,
    perTradeCap: perTrade,
    epochCap: perDay,
    venues: [venue.router],
    labels: [label16(venue.label)],
    tokens: row.instruments.map((i) => i.address),
    maxPrices: limits.map((l) => l.price),
    guards: row.instruments.filter((i) => i.feed).map((i) => ({ token: i.address, feed: i.feed!, maxDeviationBps: 100, maxStaleness: 3600 })),
    deposit,
  };
  const factory = await ethers.getContractAt("QuaestorStocks", row.factory, owner);
  await (await budget.approve(row.factory, deposit)).wait();
  const value = ethers.parseEther(row.agentGas);
  const gasLimit = ((await factory.createGovernor.estimateGas(setup, { value })) * 120n) / 100n;
  const receipt = (await (await factory.createGovernor(setup, { value, gasLimit })).wait())!;
  const created = receipt.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "GovernorCreated");
  const governor: string = created!.args.governor;
  console.log(`${row.name}: house agent governor ${governor} (tx ${receipt.hash}), operator ${agent}, ${row.agentGas} ${row.gasSymbol} to the agent`);
  row.instruments.forEach((i, k) => console.log(`  ${i.symbol}: limit ${ethers.formatUnits(limits[k].price, row.budget.decimals)} (${limits[k].from})${i.feed ? ", fills within 1% of the oracle" : ", no oracle on this chain"}`));
  const file = `deployments/house-agent-${row.key}.json`;
  fs.writeFileSync(file, JSON.stringify({
    network: row.key, chainId: row.chainId, at: new Date().toISOString(), owner: owner.address, agent, governor, tx: receipt.hash,
    perTradeCap: ethers.formatUnits(perTrade, row.budget.decimals), epochCap: ethers.formatUnits(perDay, row.budget.decimals),
    deposit: ethers.formatUnits(deposit, row.budget.decimals), budget: row.budget.symbol,
    limits: Object.fromEntries(row.instruments.map((i, k) => [i.symbol, { maxPrice: ethers.formatUnits(limits[k].price, row.budget.decimals), from: limits[k].from }])),
  }, null, 2) + "\n");
  console.log(`recorded in ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
