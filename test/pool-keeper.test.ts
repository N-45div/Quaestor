import { expect } from "chai";
import { ethers } from "hardhat";
import type { Contract } from "ethers";
import * as fs from "node:fs";
import * as path from "node:path";
import { ERC20_ABI, exactInputSingle, type Network } from "../sdk/evm-stocks";
import { DRIFT_BPS, PoolKeeper, priceFromSqrt, sqrtPriceFor } from "../services/pool-keeper";

/**
 * The testnet pool keeper, on Uniswap v3's own bytecode: a pool pushed off its
 * feed's price, either way, is traded back to it in one swap, and a pool within
 * a few basis points is left alone.
 */
describe("pool keeper — a testnet's Uniswap pools held at their feeds", () => {
  const vendor = (name: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), "vendor", "uniswap", `${name}.json`), "utf8"));
  const POOL_ABI = ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)", "function token0() view returns (address)"];

  it("converts between a price per share and Uniswap's sqrt price, whichever token sorts first", () => {
    for (const budgetIsToken0 of [true, false]) {
      const price = 357_600_000n; // $357.60 in 6-decimal units
      const back = priceFromSqrt(sqrtPriceFor(price, 18, budgetIsToken0), 18, budgetIsToken0);
      expect(Number(back - price)).to.be.within(-2, 2);
    }
  });

  async function setup() {
    const [owner] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const usdg = await Token.deploy("Test USDG", "tUSDG", 6);
    const stock = await Token.deploy("Tesla (stand-in)", "TSLA", 18);
    const [usdgAddress, stockAddress] = [await usdg.getAddress(), await stock.getAddress()];
    const deployVendor = async (name: string, args: unknown[]) => {
      const a = vendor(name);
      const c = await new ethers.ContractFactory(a.abi, a.bytecode, owner).deploy(...args);
      await c.waitForDeployment();
      return c as unknown as Contract;
    };
    const v3 = await deployVendor("UniswapV3Factory", []);
    const router = await deployVendor("SwapRouter02", [ethers.ZeroAddress, await v3.getAddress(), ethers.ZeroAddress, ethers.ZeroAddress]);
    await (await v3.createPool(usdgAddress, stockAddress, 3000)).wait();
    const pool = new ethers.Contract(await v3.getPool(usdgAddress, stockAddress, 3000), [...POOL_ABI, "function initialize(uint160)"], owner);
    const budgetIsToken0 = usdgAddress.toLowerCase() < stockAddress.toLowerCase();
    const feedPrice = 357_600_000n;
    await (await pool.initialize(sqrtPriceFor(feedPrice, 18, budgetIsToken0))).wait();

    // Liquidity 30% either side of the price, as the testnet's pools were seeded.
    const helper = await (await ethers.getContractFactory("UniV3LiquidityHelper")).deploy();
    await (await usdg.mint(await helper.getAddress(), 10_000n * 10n ** 6n)).wait();
    await (await stock.mint(await helper.getAddress(), 10n ** 19n)).wait();
    const tick = Number((await pool.slot0()).tick);
    const floorTo = (t: number) => Math.floor(t / 60) * 60;
    await (await helper.seed(await pool.getAddress(), floorTo(tick - 2600), floorTo(tick + 2600), 10n ** 15n)).wait();

    const feed = await (await ethers.getContractFactory("MockAggregator")).deploy(8);
    await (await feed.set(35_760_000_000n, Math.floor(Date.now() / 1000))).wait();

    const network = {
      key: "local", name: "local", chainId: 31337, rpcUrl: "", explorer: "", factory: "0x0000000000000000000000000000000000000001", factoryBlock: 0,
      budget: { symbol: "tUSDG", address: usdgAddress, decimals: 6, mintable: true },
      venues: [{ kind: "uniswap-v3", label: "uniswap-v3", router: await router.getAddress(), quoter: ethers.ZeroAddress, factory: await v3.getAddress() }],
      instruments: [{ symbol: "TSLA", name: "Tesla", address: stockAddress, decimals: 18, feed: await feed.getAddress(), fees: [3000] }],
    } as unknown as Network;

    // The keeper holds some of the stock; it mints its own tUSDG.
    const keeper = ethers.Wallet.createRandom().connect(ethers.provider);
    await (await owner.sendTransaction({ to: keeper.address, value: ethers.parseEther("1") })).wait();
    await (await stock.mint(keeper.address, 10n ** 18n)).wait();

    const push = async (tokenIn: Contract, tokenOut: string, amount: bigint) => {
      await (await tokenIn.mint(owner.address, amount)).wait();
      await (await tokenIn.approve(await router.getAddress(), amount)).wait();
      await (await owner.sendTransaction({ to: await router.getAddress(), data: exactInputSingle(network.venues[0], await tokenIn.getAddress(), tokenOut, 3000, owner.address, amount, 0n) })).wait();
    };
    const poolPrice = async () => priceFromSqrt((await pool.slot0()).sqrtPriceX96 as bigint, 18, budgetIsToken0);
    const keeperRun = new PoolKeeper({ network, provider: ethers.provider as never, keeperKey: keeper.privateKey });
    return { usdg: usdg as unknown as Contract, stock: stock as unknown as Contract, usdgAddress, stockAddress, keeper, keeperRun, push, poolPrice, feedPrice };
  }

  it("sells the stock into a pool that drifted over its feed, down to the feed's price", async () => {
    const s = await setup();
    await s.push(s.usdg, s.stockAddress, 100n * 10n ** 6n); // someone bought: the pool is dear
    expect(Number(((await s.poolPrice()) - s.feedPrice) * 10_000n / s.feedPrice)).to.be.greaterThan(DRIFT_BPS);
    const stockBefore: bigint = await s.stock.balanceOf(s.keeper.address);
    const [row] = await s.keeperRun.tick();
    expect(row.tx).to.match(/^0x/);
    expect(row.driftBps).to.be.greaterThan(DRIFT_BPS);
    expect(Number(((await s.poolPrice()) - s.feedPrice) * 10_000n / s.feedPrice)).to.be.within(-1, 1);
    const stockAfter: bigint = await s.stock.balanceOf(s.keeper.address);
    expect(stockAfter).to.be.lessThan(stockBefore); // it sold only what it took, not its whole balance
    expect(stockAfter).to.be.greaterThan(0n);
  });

  it("buys the stock from a pool that drifted under its feed, minting its own tUSDG", async () => {
    const s = await setup();
    await s.push(s.stock, s.usdgAddress, 3n * 10n ** 17n); // someone sold: the pool is cheap
    expect(Number(((await s.poolPrice()) - s.feedPrice) * 10_000n / s.feedPrice)).to.be.lessThan(-DRIFT_BPS);
    const [row] = await s.keeperRun.tick();
    expect(row.tx).to.match(/^0x/);
    expect(Number(((await s.poolPrice()) - s.feedPrice) * 10_000n / s.feedPrice)).to.be.within(-1, 1);
    expect(await s.usdg.balanceOf(s.keeper.address)).to.be.greaterThan(0n); // minted, and kept the rest
  });

  it("leaves a pool within a few basis points of its feed alone", async () => {
    const s = await setup();
    const [row] = await s.keeperRun.tick();
    expect(row.tx).to.equal(undefined);
    expect(Math.abs(row.driftBps)).to.be.lessThan(DRIFT_BPS);
  });
});
