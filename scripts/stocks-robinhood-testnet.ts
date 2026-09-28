/**
 * Robinhood Chain testnet, set up so the Stock Token governor runs there the
 * way it runs on mainnet. The testnet has the Stock Tokens (from Robinhood's
 * faucet) and nothing else the governor uses, so this brings the rest:
 *
 *   - tUSDG, a 6-decimal test dollar anyone can mint (mainnet uses Paxos's USDG);
 *   - Uniswap v3, deployed from Uniswap's own published bytecode (vendor/uniswap:
 *     v3-core 1.0.1's factory, v3-periphery 1.4.4's QuoterV2, swap-router-contracts
 *     1.3.1's SwapRouter02), with a tUSDG pool per stock opened at mainnet's price;
 *   - a MirrorFeed per stock: Chainlink's interface, holding the price the hub
 *     copies from the real Chainlink feed on Robinhood Chain mainnet;
 *   - the governor factory, a house governor for the refusal buttons, and the
 *     attacker's AAPL-style pool (one stock, AAPL-only above the market) at 0.01%.
 *
 *   STOCKS="TSLA=0x…,AMZN=0x…" HOUSE_OPERATOR=0x… MIRROR_RELAYER=0x… \
 *   npx hardhat run scripts/stocks-robinhood-testnet.ts --network robinhoodTestnet
 *
 * Without STOCKS (a local rehearsal) it deploys stand-in stock tokens.
 * It writes deployments/stocks-<network>.json and the network row the command,
 * the hub and the app read.
 */
import { ethers, network } from "hardhat";
import type { Contract } from "ethers";
import * as fs from "node:fs";
import * as path from "node:path";
import { ERC20_ABI, ROBINHOOD, ROBINHOOD_TESTNET, bestQuote, exactInputSingle, label16, refusalOf, type Network } from "../sdk/evm-stocks";

const WETH_TESTNET = "0x7943e237c7F95DA44E0301572D358911207852Fa";
/** Chainlink's mainnet feeds for the stocks Robinhood's testnet faucet hands out. */
const MAINNET_FEEDS: Record<string, string> = {
  TSLA: "0x4A1166a659A55625345e9515b32adECea5547C38",
  AMZN: "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C",
  PLTR: "0x820ABedFF239034956B7A9d2F0a331f9F075eB4c",
  AMD: "0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72",
};
const NAMES: Record<string, string> = { TSLA: "Tesla", AMZN: "Amazon", PLTR: "Palantir", AMD: "AMD" };
const POOL_FEE = 3000; // tick spacing 60
const ATTACKER_FEE = 100; // tick spacing 1; enabled on this factory by its owner

const vendor = (name: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), "vendor", "uniswap", `${name}.json`), "utf8"));
const sqrt = (n: bigint) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
/** Uniswap's price for a pair as a Q64.96 square root: token1 units per token0 unit. */
const sqrtPriceX96 = (token1PerToken0Num: bigint, token1PerToken0Den: bigint) => sqrt((token1PerToken0Num << 192n) / token1PerToken0Den);
const tickOf = (ratio: number) => Math.floor(Math.log(ratio) / Math.log(1.0001));
const floorTo = (t: number, s: number) => Math.floor(t / s) * s;

async function mainnetPrices(): Promise<Record<string, { answer: bigint; updatedAt: bigint }>> {
  const p = new ethers.JsonRpcProvider(ROBINHOOD.rpcUrl, ROBINHOOD.chainId, { staticNetwork: true });
  const out: Record<string, { answer: bigint; updatedAt: bigint }> = {};
  for (const [sym, feed] of Object.entries(MAINNET_FEEDS)) {
    const round = await new ethers.Contract(feed, ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], p).latestRoundData();
    out[sym] = { answer: round[1] as bigint, updatedAt: round[3] as bigint };
  }
  return out;
}

async function main() {
  const [owner] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const house = process.env.HOUSE_OPERATOR;
  const relayer = process.env.MIRROR_RELAYER ?? owner.address;
  if (!house || !ethers.isAddress(house)) throw new Error("set HOUSE_OPERATOR to the hub's operator address");
  const log = (m: string) => console.log(`[${network.name}] ${m}`);
  log(`owner ${owner.address}, ${ethers.formatEther(await ethers.provider.getBalance(owner.address))} ETH`);

  // 1. The stocks: the faucet's, or stand-ins for a rehearsal.
  const stocks: { symbol: string; address: string }[] = [];
  if (process.env.STOCKS) {
    for (const pair of process.env.STOCKS.split(",")) {
      const [symbol, address] = pair.split("=");
      if (!MAINNET_FEEDS[symbol] || !ethers.isAddress(address)) throw new Error(`STOCKS: ${pair} is not SYMBOL=address for one of ${Object.keys(MAINNET_FEEDS).join(", ")}`);
      stocks.push({ symbol, address });
    }
  } else {
    const Token = await ethers.getContractFactory("MockERC20");
    for (const symbol of Object.keys(MAINNET_FEEDS)) {
      const t = await Token.deploy(`${NAMES[symbol]} (stand-in)`, symbol, 18);
      await t.waitForDeployment();
      await (await t.mint(owner.address, 10n ** 19n)).wait();
      stocks.push({ symbol, address: await t.getAddress() });
    }
    log("no STOCKS given: deployed stand-in stock tokens");
  }

  // 2. tUSDG.
  const usdg = await (await ethers.getContractFactory("MockERC20")).deploy("Test USDG (Quaestor, testnet)", "tUSDG", 6);
  await usdg.waitForDeployment();
  await (await usdg.mint(owner.address, 1_000_000n * 10n ** 6n)).wait();
  const usdgAddress = await usdg.getAddress();
  log(`tUSDG ${usdgAddress}`);

  // 3. Uniswap v3, from Uniswap's own bytecode.
  const deployVendor = async (name: string, args: unknown[]) => {
    const a = vendor(name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, owner).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const weth = chainId === 46630n ? WETH_TESTNET : ethers.ZeroAddress;
  const v3 = await deployVendor("UniswapV3Factory", []);
  const v3Address = await v3.getAddress();
  await (await (v3 as unknown as Contract).enableFeeAmount(ATTACKER_FEE, 1)).wait();
  const quoter = await deployVendor("QuoterV2", [v3Address, weth]);
  const router = await deployVendor("SwapRouter02", [ethers.ZeroAddress, v3Address, ethers.ZeroAddress, weth]);
  const quoterAddress = await quoter.getAddress();
  const routerAddress = await router.getAddress();
  log(`Uniswap v3 factory ${v3Address}, QuoterV2 ${quoterAddress}, SwapRouter02 ${routerAddress}`);

  // 4. A tUSDG pool per stock at mainnet's price, and a mirror feed per stock.
  const prices = await mainnetPrices();
  const helper = await (await ethers.getContractFactory("UniV3LiquidityHelper")).deploy();
  await helper.waitForDeployment();
  const helperAddress = await helper.getAddress();
  const factoryV3 = v3 as unknown as Contract;
  const instruments: Network["instruments"] = [];
  const mirrors: Record<string, string> = {};
  for (const s of stocks) {
    const price = prices[s.symbol]; // 8-decimal USD
    const [token0, token1] = usdgAddress.toLowerCase() < s.address.toLowerCase() ? [usdgAddress, s.address] : [s.address, usdgAddress];
    await (await factoryV3.createPool(token0, token1, POOL_FEE)).wait();
    const pool = new ethers.Contract(await factoryV3.getPool(token0, token1, POOL_FEE), ["function initialize(uint160)", "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"], owner);
    // One share (1e18) is worth answer/1e8 dollars = answer/100 USDG base units (6 dec).
    const usdgPerShareNum = price.answer; // USDG units per 1e18 share units, times 100
    const shareUnits = 10n ** 18n * 100n;
    const sqrtP = token0 === usdgAddress ? sqrtPriceX96(shareUnits, usdgPerShareNum) : sqrtPriceX96(usdgPerShareNum, shareUnits);
    await (await pool.initialize(sqrtP)).wait();
    const [, tick] = await pool.slot0();
    const t = Number(tick);
    // Liquidity from 30% under to 30% over the price: tUSDG and the share both.
    const share = new ethers.Contract(s.address, ERC20_ABI, owner);
    const held: bigint = await share.balanceOf(owner.address);
    const seedShares = held / 2n;
    if (seedShares === 0n) throw new Error(`the owner holds no ${s.symbol}; claim it from the faucet first`);
    await (await share.transfer(helperAddress, seedShares)).wait();
    await (await usdg.transfer(helperAddress, (seedShares * price.answer) / 10n ** 20n + 10n ** 9n)).wait();
    const lower = floorTo(t - 2600, 60), upper = floorTo(t + 2600, 60);
    // The most liquidity both seeded amounts cover, from Uniswap v3's own amounts
    // for a price inside [lower, upper]: token0 = L(1/√P − 1/√Pb), token1 = L(√P − √Pa).
    const [bal0, bal1] = await Promise.all([token0, token1].map((a) => new ethers.Contract(a, ERC20_ABI, owner).balanceOf(helperAddress) as Promise<bigint>));
    const sp = Number(sqrtP) / 2 ** 96, spa = Math.pow(1.0001, lower / 2), spb = Math.pow(1.0001, upper / 2);
    const L = BigInt(Math.floor(Math.min(Number(bal0) / (1 / sp - 1 / spb), Number(bal1) / (sp - spa)) * 0.95));
    await (await helper.seed(await pool.getAddress(), lower, upper, L)).wait();

    const mirror = await (await ethers.getContractFactory("MirrorFeed")).deploy(relayer, 8, MAINNET_FEEDS[s.symbol], `${s.symbol} / USD (testnet mirror of Chainlink's Robinhood Chain mainnet feed)`);
    await mirror.waitForDeployment();
    const mirrorAddress = await mirror.getAddress();
    if (relayer === owner.address) await (await mirror.mirror(price.answer, price.updatedAt)).wait();
    mirrors[s.symbol] = mirrorAddress;
    instruments.push({ symbol: s.symbol, name: NAMES[s.symbol], address: s.address, decimals: 18, feed: mirrorAddress, fees: [POOL_FEE] });
    log(`${s.symbol}: pool at $${Number(price.answer) / 1e8}, mirror feed ${mirrorAddress}`);
  }

  // 5. The governor factory, the house governor, and the attacker's pool on the first stock.
  const factory = await (await ethers.getContractFactory("QuaestorStocks")).deploy();
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  const factoryBlock = (await factory.deploymentTransaction()!.wait())!.blockNumber;
  const first = instruments[0];
  await (await usdg.approve(factoryAddress, 5n * 10n ** 6n)).wait();
  const created = await (await factory.createGovernor({
    operator: house,
    budgetToken: usdgAddress,
    epochLength: 86_400,
    perTradeCap: 2n * 10n ** 6n,
    epochCap: 10n * 10n ** 6n,
    venues: [routerAddress],
    labels: [label16("uniswap-v3")],
    tokens: [first.address],
    maxPrices: [(prices[first.symbol].answer * 11n) / 10n / 100n], // 10% over the market, in tUSDG units
    guards: [{ token: first.address, feed: first.feed!, maxDeviationBps: 100, maxStaleness: 3 * 86_400 }],
    deposit: 5n * 10n ** 6n,
  }, { value: ethers.parseEther("0.0005") })).wait();
  const ev = created!.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "GovernorCreated");
  const houseGovernor: string = ev!.args.governor;

  // The attacker's pool: the first stock, at a million dollars a share, stock-only below the market price.
  const [a0, a1] = usdgAddress.toLowerCase() < first.address.toLowerCase() ? [usdgAddress, first.address] : [first.address, usdgAddress];
  await (await factoryV3.createPool(a0, a1, ATTACKER_FEE)).wait();
  const attackerPool = await factoryV3.getPool(a0, a1, ATTACKER_FEE);
  const ap = new ethers.Contract(attackerPool, ["function initialize(uint160)"], owner);
  const usdgIs0 = a0 === usdgAddress;
  // Price in token1 per token0 raw units; the pool opens a little cheaper than $1M and sells only above it.
  const ratioAt = (usd: number) => (usdgIs0 ? 1e12 / usd : usd / 1e12);
  const open = usdgIs0 ? sqrtPriceX96(10n ** 12n, 900_000n) : sqrtPriceX96(900_000n, 10n ** 12n);
  await (await ap.initialize(open)).wait();
  const [tA, tB] = [tickOf(ratioAt(1_100_000)), tickOf(ratioAt(1_000_000))].sort((x, y) => x - y);
  await (await new ethers.Contract(first.address, ERC20_ABI, owner).transfer(helperAddress, 10n ** 13n)).wait();
  await (await helper.seed(attackerPool, tA, tB, 10n ** 11n)).wait();
  log(`factory ${factoryAddress}, house governor ${houseGovernor}, attacker's pool ${attackerPool}`);

  const row: Network = {
    ...ROBINHOOD_TESTNET,
    factory: factoryAddress,
    factoryBlock,
    budget: { symbol: "tUSDG", address: usdgAddress, decimals: 6, mintable: true },
    venues: [{ kind: "uniswap-v3", label: "uniswap-v3", router: routerAddress, quoter: quoterAddress, factory: v3Address }],
    instruments,
  };
  const out = {
    network: network.name,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: owner.address,
    contracts: { QuaestorStocks: factoryAddress, tUSDG: usdgAddress, UniswapV3Factory: v3Address, QuoterV2: quoterAddress, SwapRouter02: routerAddress, liquidityHelper: helperAddress, houseGovernor, attackerPool, mirrors },
    row,
  };
  if (network.name === "hardhat") return rehearse(row, houseGovernor, attackerPool);
  const file = path.join(process.cwd(), "deployments", `stocks-${network.name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  log(`recorded in ${path.relative(process.cwd(), file)}`);
}

/**
 * On the in-process chain only: prove the stack trades before it is deployed
 * anywhere. An agent's governor buys through the deployed router at what
 * QuoterV2 said, and a hijacked trade into the attacker's pool is refused.
 */
async function rehearse(row: Network, houseGovernor: string, attackerPool: string) {
  const [owner, agent] = await ethers.getSigners();
  const inst = row.instruments[0];
  const venue = row.venues[0];
  const factory = await ethers.getContractAt("QuaestorStocks", row.factory);
  const usdg = new ethers.Contract(row.budget.address, ERC20_ABI, owner);
  await (await usdg.approve(row.factory, 20n * 10n ** 6n)).wait();
  const rc = await (await factory.createGovernor({
    operator: agent.address, budgetToken: row.budget.address, epochLength: 86_400, perTradeCap: 5n * 10n ** 6n, epochCap: 20n * 10n ** 6n,
    venues: [venue.router], labels: [label16(venue.label)], tokens: [inst.address], maxPrices: [10n ** 9n],
    guards: [{ token: inst.address, feed: inst.feed!, maxDeviationBps: 150, maxStaleness: 3 * 86_400 }], deposit: 20n * 10n ** 6n,
  })).wait();
  const ev = rc!.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "GovernorCreated");
  const g = await ethers.getContractAt("QuaestorStockGovernor", ev!.args.governor);
  const gov = await g.getAddress();
  const amountIn = 5n * 10n ** 6n;
  const q = await bestQuote(ethers.provider, row, inst, amountIn);
  const minOut = (q.amountOut * 99n) / 100n;
  await (await g.connect(agent).executeTrade({
    intentId: ethers.id("rehearsal-buy"), venue: venue.router, tokenOut: inst.address, amountIn, minOut,
    decisionHash: ethers.ZeroHash, swapData: q.swapData(gov, minOut),
  })).wait();
  const held: bigint = await new ethers.Contract(inst.address, ERC20_ABI, owner).balanceOf(gov);
  console.log(`[rehearsal] bought ${ethers.formatUnits(held, 18)} ${inst.symbol} for 5 tUSDG, quoted ${ethers.formatUnits(q.amountOut, 18)}: ${held === q.amountOut ? "exactly as quoted" : "NOT as quoted"}`);
  try {
    await g.connect(agent).executeTrade.staticCall({
      intentId: ethers.id("rehearsal-hijack"), venue: venue.router, tokenOut: inst.address, amountIn: 10n ** 6n, minOut: 1n,
      decisionHash: ethers.ZeroHash, swapData: exactInputSingle(venue, row.budget.address, inst.address, ATTACKER_FEE, gov, 10n ** 6n, 1n),
    });
    console.log("[rehearsal] the hijacked trade was NOT refused");
  } catch (e) {
    console.log(`[rehearsal] hijacked trade into the attacker's pool ${attackerPool}: ${refusalOf(e)?.detail ?? (e as Error).message.slice(0, 160)}`);
  }
  console.log(`[rehearsal] house governor ${houseGovernor} holds ${ethers.formatUnits(await usdg.balanceOf(houseGovernor), 6)} tUSDG`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
