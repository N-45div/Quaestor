/**
 * Monad testnet, set up so the governor trades on Kuru, Monad's on-chain order
 * book. Kuru's only testnet market (MON/USDC) delivers native MON and takes
 * orders of 200 MON or more, so this brings a market of its own, which Kuru's
 * Router lets anyone deploy:
 *
 *   - tETH and tUSDC, test tokens anyone may mint;
 *   - a tETH/tUSDC Kuru market, with sell orders placed just over Chainlink's
 *     real ETH/USD price on Monad testnet;
 *   - the attacker's own tETH/tUSDC Kuru market, one sell order at $400,000;
 *   - the house governor for the refusal buttons: tUSDC budget, Kuru's Router
 *     as its only venue, tETH at no more than 10% over Chainlink, and the
 *     Chainlink ETH/USD feed as its price guard.
 *
 *   HOUSE_OPERATOR=0x… npx hardhat run scripts/stocks-monad-kuru.ts --network monadTestnet
 *
 * Every transaction is estimated before it is sent, so a step that would fail
 * stops the script without spending the gas limit Monad charges.
 */
import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { ERC20_ABI, KURU_ORDERBOOK_ABI, KURU_ROUTER_ABI, MONAD_TESTNET, bestQuote, label16, type Network } from "../sdk/evm-stocks";

const KURU_ROUTER = "0x7EFbE105Ca7415dE98F96622173458ac1c054630";
const KURU_MARGIN = "0xd029C2D98ff85D8F64799017fE00a59B1159CE02";
const CHAINLINK_ETH_USD = "0x5c8c8482f064049248F86D9F4aFa4B1f2F5b6d31"; // Monad testnet, 8 decimals
const MARGIN_ABI = ["function deposit(address _user, address _token, uint256 _amount) payable", "function getBalance(address _user, address _token) view returns (uint256)"];

// The book's units, as Kuru's own SDK derives them for a price near $2,600 and a
// 0.0001 ETH minimum: prices in 1e-4 dollars, sizes in 1e-9 ETH.
const PRICE_PRECISION = 10_000;
const SIZE_PRECISION = 1_000_000_000n;
const TICK = 100; // one cent
const toPrice = (usd: number) => Math.round((usd * PRICE_PRECISION) / TICK) * TICK;

async function main() {
  const [owner] = await ethers.getSigners();
  const house = process.env.HOUSE_OPERATOR;
  if (!house || !ethers.isAddress(house)) throw new Error("set HOUSE_OPERATOR to the hub's operator address");
  const log = (m: string) => console.log(`[${network.name}] ${m}`);
  log(`owner ${owner.address}, ${ethers.formatEther(await ethers.provider.getBalance(owner.address))} MON`);
  const factoryAddress = process.env.FACTORY ?? MONAD_TESTNET.factory;

  const feed = new ethers.Contract(CHAINLINK_ETH_USD, ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], ethers.provider);
  const [, answer, , updatedAt] = await feed.latestRoundData();
  const ethUsd = Number(answer) / 1e8;
  log(`Chainlink ETH/USD ${ethUsd} (updated ${new Date(Number(updatedAt) * 1000).toISOString()})`);

  // 1. The tokens.
  const Token = await ethers.getContractFactory("MockERC20");
  const teth = await Token.deploy("Test ETH (Quaestor, Monad testnet)", "tETH", 18);
  await teth.waitForDeployment();
  const tusdc = await Token.deploy("Test USDC (Quaestor, Monad testnet)", "tUSDC", 6);
  await tusdc.waitForDeployment();
  const tethAddress = await teth.getAddress();
  const tusdcAddress = await tusdc.getAddress();
  await (await teth.mint(owner.address, 10n ** 19n)).wait();
  await (await tusdc.mint(owner.address, 10_000n * 10n ** 6n)).wait();
  log(`tETH ${tethAddress}, tUSDC ${tusdcAddress}`);

  // 2. The markets, through Kuru's Router.
  const router = new ethers.Contract(KURU_ROUTER, KURU_ROUTER_ABI, owner);
  const deployMarket = async (minSize: bigint) => {
    const args = [0, tethAddress, tusdcAddress, SIZE_PRECISION, PRICE_PRECISION, TICK, minSize, 10n ** 11n, 0, 0, 100] as const;
    const market: string = await router.deployProxy.staticCall(...args);
    await (await router.deployProxy(...args)).wait();
    return market;
  };
  const marketAddress = await deployMarket(100_000n); // 0.0001 ETH minimum
  const attackerMarket = await deployMarket(1n);
  log(`Kuru market ${marketAddress}; the attacker's market ${attackerMarket}`);

  // 3. Liquidity: tETH into Kuru's margin account, then sell orders over Chainlink's price.
  const margin = new ethers.Contract(KURU_MARGIN, MARGIN_ABI, owner);
  await (await teth.approve(KURU_MARGIN, 5n * 10n ** 18n)).wait();
  await (await margin.deposit(owner.address, tethAddress, 5n * 10n ** 18n)).wait();
  const book = new ethers.Contract(marketAddress, KURU_ORDERBOOK_ABI, owner);
  for (const [overPct, eth] of [[0.1, 0.2], [0.3, 0.5], [0.6, 1]] as const) {
    await (await book.addSellOrder(toPrice(ethUsd * (1 + overPct / 100)), BigInt(Math.round(eth * 1e9)), true)).wait();
  }
  // The attacker's one order: a hundred-thousandth of an ETH at $400,000.
  await (await new ethers.Contract(attackerMarket, KURU_ORDERBOOK_ABI, owner).addSellOrder(toPrice(400_000), 10_000n, true)).wait();
  const [bid, ask] = await book.bestBidAsk();
  log(`book: best ask ${Number(ask) / 1e18} (bid ${bid === ethers.MaxUint256 ? "none" : bid})`);

  // 4. The house governor.
  const factory = await ethers.getContractAt("QuaestorStocks", factoryAddress);
  await (await tusdc.approve(factoryAddress, 5n * 10n ** 6n)).wait();
  const limit = BigInt(Math.round(ethUsd * 1.1 * 1e6));
  const receipt = await (await factory.createGovernor({
    operator: house,
    budgetToken: tusdcAddress,
    epochLength: 86_400,
    perTradeCap: 2n * 10n ** 6n,
    epochCap: 10n * 10n ** 6n,
    venues: [KURU_ROUTER],
    labels: [label16("kuru")],
    tokens: [tethAddress],
    maxPrices: [limit],
    guards: [{ token: tethAddress, feed: CHAINLINK_ETH_USD, maxDeviationBps: 150, maxStaleness: 2 * 86_400 }],
    deposit: 5n * 10n ** 6n,
  }, { value: ethers.parseEther("0.3") })).wait();
  const ev = receipt!.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "GovernorCreated");
  const houseGovernor: string = ev!.args.governor;
  log(`house governor ${houseGovernor} (limit $${Number(limit) / 1e6} a tETH)`);

  const row: Network = {
    ...MONAD_TESTNET,
    factory: factoryAddress,
    budget: { symbol: "tUSDC", address: tusdcAddress, decimals: 6, mintable: true },
    venues: [{ kind: "kuru", label: "kuru", router: KURU_ROUTER, markets: { [tethAddress.toLowerCase()]: { address: marketAddress, pricePrecision: PRICE_PRECISION } } }],
    instruments: [{ symbol: "tETH", name: "Test ETH", address: tethAddress, decimals: 18, feed: CHAINLINK_ETH_USD, fees: [] }],
  };
  const q = await bestQuote(ethers.provider, row, row.instruments[0], 10n ** 6n);
  log(`quote: 1 tUSDC buys ${ethers.formatUnits(q.amountOut, 18)} tETH on ${q.label} ($${(1 / Number(ethers.formatUnits(q.amountOut, 18))).toFixed(2)} a tETH)`);

  const out = {
    network: network.name,
    chainId: MONAD_TESTNET.chainId,
    deployedAt: new Date().toISOString(),
    deployer: owner.address,
    contracts: { QuaestorStocks: factoryAddress, tETH: tethAddress, tUSDC: tusdcAddress, kuruMarket: marketAddress, attackerMarket, houseGovernor, kuruRouter: KURU_ROUTER, chainlinkEthUsd: CHAINLINK_ETH_USD },
    row,
  };
  const file = path.join(process.cwd(), "deployments", `stocks-${network.name}-kuru.json`);
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  log(`recorded in ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
