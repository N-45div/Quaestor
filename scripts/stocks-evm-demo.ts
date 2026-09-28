/**
 * The demonstration the hub's "try to break it" buttons send trades to:
 * a house governor with a few dollars in it, and the attacker's own pool.
 *
 *   HOUSE_OPERATOR=0x… [FACTORY=0x…] [FUND_FROM_WHALE=1] \
 *   npx hardhat run scripts/stocks-evm-demo.ts --network <robinhood|localhost>
 *
 * The house governor belongs to the deployer; its operator is the hub's key.
 * It may spend 2 USDG a trade and 10 a day, only on AAPL, only through
 * Uniswap's router, at no more than $370 a share and 1% over Chainlink.
 *
 * The attacker's pool is a real Uniswap v3 AAPL/USDG pool at the 0.01% tier,
 * opened at about $900,000 a share, holding a few millionths of a share and no
 * USDG at all, in a range from $1M to $1.1M. Nobody can take anything out of it
 * (there is nothing to buy back), and a trade routed into it pays a million
 * dollars a share for dust: exactly what a hijacked agent with a floor of one
 * wei would accept, and what the owner's limit price refuses.
 */
import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { ERC20_ABI, NETWORKS, ROBINHOOD, exactInputSingle, label16, type Network } from "../sdk/evm-stocks";

const USDG_WHALE = "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3"; // for forks only
const ATTACKER_FEE = 100;
const usd = (x: number) => BigInt(Math.round(x * 1e6));
const sqrt = (n: bigint) => { let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
/** Uniswap's tick for a price in dollars a share, with USDG as token0 (6 dec) and the share as token1 (18 dec). */
const tickFor = (usdPerShare: number) => Math.floor(Math.log(1e12 / usdPerShare) / Math.log(1.0001));

async function main() {
  const house = process.env.HOUSE_OPERATOR;
  if (!house || !ethers.isAddress(house)) throw new Error("set HOUSE_OPERATOR to the hub's operator address");
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const row: Network | undefined = Object.values(NETWORKS).find((n) => n.chainId === chainId);
  if (!row || row.key !== ROBINHOOD.key) throw new Error(`this demonstration needs Robinhood Chain (4663) or a fork of it; got ${chainId}`);
  const [owner] = await ethers.getSigners();
  const usdg = new ethers.Contract(row.budget.address, ERC20_ABI, owner);
  const aapl = row.instruments.find((i) => i.symbol === "AAPL")!;
  const venue = row.venues[0];

  if (process.env.FUND_FROM_WHALE) {
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [USDG_WHALE] });
    await network.provider.request({ method: "hardhat_setBalance", params: [USDG_WHALE, "0x56BC75E2D63100000"] });
    await (await new ethers.Contract(row.budget.address, ERC20_ABI, await ethers.getSigner(USDG_WHALE)).transfer(owner.address, usd(100))).wait();
  }

  // The factory: the one this network row names, or a new one.
  let factoryAddress = process.env.FACTORY ?? row.factory;
  let factoryBlock = row.factoryBlock;
  if (!factoryAddress) {
    const f = await (await ethers.getContractFactory("QuaestorStocks")).deploy();
    await f.waitForDeployment();
    factoryAddress = await f.getAddress();
    factoryBlock = (await f.deploymentTransaction()!.wait())!.blockNumber;
    console.log(`factory deployed at ${factoryAddress} (block ${factoryBlock})`);
  }
  const factory = await ethers.getContractAt("QuaestorStocks", factoryAddress);

  // 1. The house governor.
  await (await usdg.approve(factoryAddress, usd(5))).wait();
  const receipt = await (await factory.connect(owner).createGovernor({
    operator: house,
    budgetToken: row.budget.address,
    epochLength: 86_400,
    perTradeCap: usd(2),
    epochCap: usd(10),
    venues: [venue.router],
    labels: [label16(venue.label)],
    tokens: [aapl.address],
    maxPrices: [usd(370)],
    guards: [{ token: aapl.address, feed: aapl.feed!, maxDeviationBps: 100, maxStaleness: 3 * 86_400 }],
    deposit: usd(5),
  }, { value: ethers.parseEther("0.0005") })).wait();
  const created = receipt!.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "GovernorCreated");
  const governorAddress: string = created!.args.governor;
  const governor = await ethers.getContractAt("QuaestorStockGovernor", governorAddress);
  console.log(`house governor ${governorAddress}, operator ${house}`);

  // 2. The attacker's pool, if it is not there yet.
  const v3 = new ethers.Contract(venue.factory, ["function getPool(address,address,uint24) view returns (address)", "function createPool(address,address,uint24) returns (address)"], owner);
  let pool: string = await v3.getPool(row.budget.address, aapl.address, ATTACKER_FEE);
  if (pool === ethers.ZeroAddress) {
    await (await v3.createPool(row.budget.address, aapl.address, ATTACKER_FEE)).wait();
    pool = await v3.getPool(row.budget.address, aapl.address, ATTACKER_FEE);
    const p = new ethers.Contract(pool, ["function initialize(uint160)"], owner);
    // Opened at about $900,000 a share, above the range, so the position below holds only AAPL.
    const ratio = 10n ** 12n / 900_000n;
    await (await p.initialize(sqrt(ratio) * (1n << 96n))).wait();

    // A few millionths of a share, bought honestly on the real pool, seed it.
    const dustIn = usd(0.05);
    await (await usdg.approve(venue.router, dustIn)).wait();
    const helper = await (await ethers.getContractFactory("UniV3LiquidityHelper")).deploy();
    await helper.waitForDeployment();
    await (await owner.sendTransaction({ to: venue.router, data: exactInputSingle(venue, row.budget.address, aapl.address, 500, await helper.getAddress(), dustIn, 1n) })).wait();
    // Ticks: the dollar price rises as the tick falls, so $1.1M is the lower tick.
    await (await helper.seed(pool, tickFor(1_100_000), tickFor(1_000_000), 10n ** 11n)).wait();
    console.log(`attacker's pool ${pool}: AAPL only, $1M-$1.1M a share`);
  } else {
    console.log(`attacker's pool already open at ${pool}`);
  }

  const out = { network: row.key, chainId, factory: factoryAddress, factoryBlock, houseGovernor: governorAddress, houseOperator: house, attackerPool: pool, attackerFee: ATTACKER_FEE };
  const file = path.join(process.cwd(), "runs", `stocks-evm-demo.${chainId === 4663 && process.env.FUND_FROM_WHALE ? "fork" : row.key}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
