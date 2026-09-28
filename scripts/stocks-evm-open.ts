/**
 * Open a governor for an agent key, as its owner would from the app's register
 * page: every stock the chain's row lists, each at 10% over its oracle price,
 * each with that oracle as its price guard, a deposit, and the agent's gas.
 *
 *   OPERATOR=0x… [DEPOSIT=20] [PER_TRADE=5] [EPOCH_CAP=20] \
 *   npx hardhat run scripts/stocks-evm-open.ts --network monadTestnet
 *
 * The signer is the owner. On a testnet whose budget token anyone may mint,
 * it mints the deposit first.
 */
import { ethers, network } from "hardhat";
import { ERC20_ABI, NETWORKS, label16, oraclePrice } from "../sdk/evm-stocks";

async function main() {
  const [owner] = await ethers.getSigners();
  const operator = process.env.OPERATOR;
  if (!operator || !ethers.isAddress(operator)) throw new Error("set OPERATOR to the agent key's address");
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const n = Object.values(NETWORKS).find((x) => x.chainId === chainId && x.factory);
  if (!n) throw new Error(`no deployed row for chain ${chainId}`);
  const units = (v: string) => ethers.parseUnits(v, n.budget.decimals);
  const deposit = units(process.env.DEPOSIT ?? "20");

  const budget = new ethers.Contract(n.budget.address, [...ERC20_ABI, "function mint(address,uint256)"], owner);
  if (n.budget.mintable && (await budget.balanceOf(owner.address)) < deposit) await (await budget.mint(owner.address, deposit)).wait();
  await (await budget.approve(n.factory, deposit)).wait();

  const limits = await Promise.all(n.instruments.map(async (i) => {
    const o = i.feed ? await oraclePrice(ethers.provider, i.feed, n.budget.decimals) : null;
    if (!o) throw new Error(`${i.symbol} has no feed to set a limit from`);
    return (o.price * 11n) / 10n;
  }));
  const factory = await ethers.getContractAt("QuaestorStocks", n.factory);
  const receipt = await (await factory.createGovernor({
    operator,
    budgetToken: n.budget.address,
    epochLength: 86_400,
    perTradeCap: units(process.env.PER_TRADE ?? "5"),
    epochCap: units(process.env.EPOCH_CAP ?? "20"),
    venues: n.venues.map((v) => v.router),
    labels: n.venues.map((v) => label16(v.label)),
    tokens: n.instruments.map((i) => i.address),
    maxPrices: limits,
    guards: n.instruments.filter((i) => i.feed).map((i) => ({ token: i.address, feed: i.feed!, maxDeviationBps: 150, maxStaleness: 2 * 86_400 })),
    deposit,
  }, { value: ethers.parseEther(n.agentGas) })).wait();
  const ev = receipt!.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "GovernorCreated");
  console.log(`[${network.name}] governor ${ev!.args.governor} for ${operator}: ${ethers.formatUnits(deposit, n.budget.decimals)} ${n.budget.symbol}, limits ${n.instruments.map((i, k) => `${i.symbol} ${ethers.formatUnits(limits[k], n.budget.decimals)}`).join(", ")}, tx ${receipt!.hash}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
