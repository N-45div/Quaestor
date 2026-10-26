import { expect } from "chai";
import { ethers, network } from "hardhat";
import { HSK_MAINNET as HSK, bestQuote, fillPrice, oraclePrice } from "../sdk/evm-stocks";

/**
 * The governor against the real thing on a fork of HSK Chain mainnet: real USDT, real WHSK, HSKSwap's own SwapRouter02
 * and QuoterV2. A buy, a sale, and the owner's stop, each through calldata the SDK built from a live quote, exactly as
 * the agent sends it.
 *
 * APRO's feeds answer "No access" to a contract, so the governor's price here is the WHSK/USDT pool's own 30-minute
 * average (contracts/UniV3TwapFeed.sol), after the pool is asked to keep a short history.
 *
 * It runs with `FORK_HSK=1` and skips itself otherwise:
 *
 *   FORK_HSK=1 npx hardhat test test/quaestor-stocks-hsk-fork.test.ts
 */
const USD = 10n ** 6n;
const DAY = 86_400;
const WINDOW = 1800;
const label = (s: string) => ethers.zeroPadBytes(ethers.toUtf8Bytes(s), 16);
// The WHSK/USDT 0.3% pool, about $444k deep on Oct 26 2026; also the USDT holder that funds the owner.
const WHSK_POOL = "0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC";

const erc20 = (addr: string, signer?: any) =>
  new ethers.Contract(addr, [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
    "function approve(address,uint256) returns (bool)",
  ], signer ?? ethers.provider);

async function impersonate(addr: string) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.request({ method: "hardhat_setBalance", params: [addr, "0x56BC75E2D63100000"] });
  return ethers.getSigner(addr);
}

(process.env.FORK_HSK ? describe : describe.skip)("QuaestorStocks against HSKSwap on HSK Chain", function () {
  this.timeout(300_000);
  const whsk = HSK.instruments.find((i) => i.symbol === "WHSK")!;
  const venue = HSK.venues[0];

  let snapshot: string;
  beforeEach(async () => { snapshot = await network.provider.send("evm_snapshot"); });
  afterEach(async () => { await network.provider.send("evm_revert", [snapshot]); });

  async function setup(window = WINDOW) {
    const [owner, operator, guardian] = await ethers.getSigners();
    // One observation is all these pools keep; with it, a 30-minute average fails for half an hour after any swap.
    const pool = new ethers.Contract(WHSK_POOL, ["function increaseObservationCardinalityNext(uint16)"], owner);
    await (await pool.increaseObservationCardinalityNext(16)).wait();
    const feed = await (await ethers.getContractFactory("UniV3TwapFeed")).deploy(WHSK_POOL, whsk.address, window, "WHSK / USDT, HSKSwap 30-minute TWAP");

    const whale = await impersonate(WHSK_POOL);
    await (await erc20(HSK.budget.address, whale).transfer(owner.address, 100n * USD)).wait();
    const factory = await (await ethers.getContractFactory("QuaestorStocks")).deploy();
    await (await erc20(HSK.budget.address, owner).approve(await factory.getAddress(), 50n * USD)).wait();
    const tx = await factory.connect(owner).createGovernor({
      operator: operator.address,
      budgetToken: HSK.budget.address,
      epochLength: DAY,
      perTradeCap: 20n * USD,
      epochCap: 50n * USD,
      venues: [venue.router],
      labels: [label(venue.label)],
      tokens: [whsk.address],
      maxPrices: [0n],
      guards: [{ token: whsk.address, feed: await feed.getAddress(), maxDeviationBps: 300, maxStaleness: 3600 }],
      deposit: 50n * USD,
    });
    const created = (await tx.wait())!.logs.map((l: any) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "GovernorCreated")!;
    const governor = await ethers.getContractAt("QuaestorStockGovernor", created.args.governor);
    await (await governor.connect(owner).setGuardian(guardian.address)).wait();
    return { owner, operator, guardian, governor, gov: await governor.getAddress(), feed };
  }

  it("reads the pool's 30-minute average as a feed, near APRO's price and the pool's own", async () => {
    const { feed } = await setup();
    const p = ethers.provider;
    const twap = await oraclePrice(p, await feed.getAddress(), HSK.budget.decimals);
    const apro = await oraclePrice(p, whsk.feed!, HSK.budget.decimals); // an outside caller, which APRO answers
    const spot = await bestQuote(p, HSK, whsk, 1n * USD, "buy");
    const spotPrice = fillPrice(1n * USD, spot.amountOut, whsk.decimals);
    const bps = (a: bigint, b: bigint) => Number(((a > b ? a - b : b - a) * 10_000n) / b);
    expect(twap.updatedAt).to.be.greaterThan(0);
    expect(bps(twap.price, apro.price)).to.be.lessThan(300);
    // The quote includes the 0.3% fee and a dollar's impact; the average is the pool's mid price.
    expect(bps(spotPrice, twap.price)).to.be.lessThan(150);
  });

  it("buys WHSK with USDT through HSKSwap, sells half back, and carries out the owner's stop", async () => {
    const { owner, operator, guardian, governor, gov, feed } = await setup();
    const p = ethers.provider;

    // A buy: the SDK's live quote, the SDK's calldata, the governor's checks.
    const spend = 10n * USD;
    const buy = await bestQuote(p, HSK, whsk, spend, "buy");
    const minOut = (buy.amountOut * 99n) / 100n;
    await expect(governor.connect(operator).executeTrade({
      intentId: ethers.id("buy-1"), venue: buy.target, tokenOut: whsk.address, amountIn: spend, minOut,
      decisionHash: ethers.id("buy WHSK"), swapData: buy.swapData(gov, minOut),
    })).to.emit(governor, "TradeExecuted");
    const held = await erc20(whsk.address).balanceOf(gov);
    expect(held).to.be.gte(minOut);
    expect(await erc20(HSK.budget.address).balanceOf(gov)).to.equal(40n * USD);

    // A sale of half, held to the pool's average within the owner's 3%.
    const half = held / 2n;
    const sale = await bestQuote(p, HSK, whsk, half, "sell");
    const saleMin = (sale.amountOut * 99n) / 100n;
    await expect(governor.connect(operator).executeSale({
      intentId: ethers.id("sell-1"), venue: sale.target, tokenIn: whsk.address, amountIn: half, minOut: saleMin,
      decisionHash: ethers.id("sell half"), swapData: sale.swapData(gov, saleMin),
    })).to.emit(governor, "SaleExecuted");
    expect(await erc20(whsk.address).balanceOf(gov)).to.equal(held - half);

    // The owner's stop. Set under the price, the guardian is refused; set over it, the guardian sells the rest while
    // the agent is suspended.
    const price = (await oraclePrice(p, await feed.getAddress(), HSK.budget.decimals)).price;
    const rest = held - half;
    const stopQuote = await bestQuote(p, HSK, whsk, rest, "sell");
    const stopMin = (stopQuote.amountOut * 99n) / 100n;
    const stopSale = (id: string) => ({
      intentId: ethers.id(id), venue: stopQuote.target, tokenIn: whsk.address, amountIn: rest, minOut: stopMin,
      decisionHash: ethers.id("stop"), swapData: stopQuote.swapData(gov, stopMin),
    });
    await (await governor.connect(owner).setSaleLimits(whsk.address, 0n, price / 2n)).wait();
    await expect(governor.connect(guardian).triggerStopLoss(stopSale("stop-early"))).to.be.revertedWithCustomError(governor, "StopNotReached");
    await (await governor.connect(owner).setSaleLimits(whsk.address, 0n, price * 2n)).wait();
    await (await governor.connect(guardian).setSuspended(true)).wait();
    await expect(governor.connect(guardian).triggerStopLoss(stopSale("stop-1")))
      .to.emit(governor, "SaleExecuted")
      .withArgs(ethers.id("stop-1"), venue.router, whsk.address, rest, (v: bigint) => v >= stopMin, ethers.id("stop"), true);
    expect(await erc20(whsk.address).balanceOf(gov)).to.equal(0n);
  });

  it("refuses a sale too far under the pool's average, and fails closed on a pool without enough history", async () => {
    const { owner, operator, governor, gov } = await setup();
    const p = ethers.provider;
    const buy = await bestQuote(p, HSK, whsk, 10n * USD, "buy");
    await (await governor.connect(operator).executeTrade({
      intentId: ethers.id("buy-2"), venue: buy.target, tokenOut: whsk.address, amountIn: 10n * USD, minOut: 1n,
      decisionHash: ethers.id("buy"), swapData: buy.swapData(gov, 1n),
    })).wait();
    const held = await erc20(whsk.address).balanceOf(gov);
    const sale = await bestQuote(p, HSK, whsk, held, "sell");
    const sell = (id: string) => governor.connect(operator).executeSale({
      intentId: ethers.id(id), venue: sale.target, tokenIn: whsk.address, amountIn: held, minOut: 1n,
      decisionHash: ethers.id("sell"), swapData: sale.swapData(gov, 1n),
    });
    // A margin of 0.1%: the pool's fee alone puts the sale outside it.
    const tight = await (await ethers.getContractFactory("UniV3TwapFeed")).deploy(WHSK_POOL, whsk.address, WINDOW, "tight");
    await (await governor.connect(owner).setPriceGuard(whsk.address, await tight.getAddress(), 10, 3600)).wait();
    await expect(sell("sell-2")).to.be.revertedWithCustomError(governor, "FillBelowOracle");
    // An average over 30 days, which this pool has no history for: no price, no sale.
    const long = await (await ethers.getContractFactory("UniV3TwapFeed")).deploy(WHSK_POOL, whsk.address, 30 * DAY, "too long");
    await (await governor.connect(owner).setPriceGuard(whsk.address, await long.getAddress(), 300, 3600)).wait();
    await expect(sell("sell-3")).to.be.revertedWith("OLD");
  });
});
