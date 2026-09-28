import { expect } from "chai";
import { ethers, network } from "hardhat";

/**
 * The Stock Token governor against the real thing, on a fork of Robinhood Chain
 * mainnet: real USDG, the real AAPL Stock Token, Uniswap's own SwapRouter02 and
 * QuoterV2, and Chainlink's AAPL feed. The mock venues prove the rules; only
 * this proves they hold against contracts nobody here wrote.
 *
 * It runs with `FORK_ROBINHOOD=1` and skips itself otherwise:
 *
 *   FORK_ROBINHOOD=1 npx hardhat test test/quaestor-stocks-robinhood-fork.test.ts
 */
const RH = {
  // Verified on-chain 28 Sep 2026 (eth_getCode, symbol(), decimals()).
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", // 6 decimals, Paxos
  aapl: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", // 18 decimals, Robinhood Assets (Jersey)
  swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
  quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  // Chainlink "Robinhood AAPL / USD", 8 decimals, 24/5 hours (reference-data-directory, feeds-robinhood-mainnet).
  aaplFeed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0",
  // The deepest USDG pool on the chain (NVDA/USDG, 0.05%): a USDG holder to fund the owner from.
  usdgHolder: "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3",
  // AAPL/USDG at 0.05%, about $208k deep on 28 Sep 2026: an AAPL holder for the attacker's pool.
  aaplHolder: "0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D",
  fee: 500,
};

const USD = 10n ** 6n;
const DAY = 86_400;
const label = (s: string) => ethers.zeroPadBytes(ethers.toUtf8Bytes(s), 16);

const routerIface = new ethers.Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);
const exactInputSingle = (fee: number, recipient: string, amountIn: bigint, minOut: bigint) =>
  routerIface.encodeFunctionData("exactInputSingle", [{
    tokenIn: RH.usdg, tokenOut: RH.aapl, fee, recipient, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0,
  }]);

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

(process.env.FORK_ROBINHOOD ? describe : describe.skip)("QuaestorStocks against real Stock Tokens on Robinhood Chain", function () {
  this.timeout(180_000);

  // Each case starts from the forked chain as it was: the attacker's pool is opened fresh each time.
  let snapshot: string;
  beforeEach(async () => { snapshot = await network.provider.send("evm_snapshot"); });
  afterEach(async () => { await network.provider.send("evm_revert", [snapshot]); });

  async function deploy() {
    const [owner, operator, attacker] = await ethers.getSigners();
    const whale = await impersonate(RH.usdgHolder);
    await erc20(RH.usdg, whale).transfer(owner.address, 100n * USD);

    const factory = await (await ethers.getContractFactory("QuaestorStocks")).deploy();
    await erc20(RH.usdg, owner).approve(await factory.getAddress(), 50n * USD);
    const tx = await factory.connect(owner).createGovernor({
      operator: operator.address,
      budgetToken: RH.usdg,
      epochLength: DAY,
      perTradeCap: 5n * USD,
      epochCap: 20n * USD,
      venues: [RH.swapRouter02],
      labels: [label("uniswap-v3")],
      tokens: [RH.aapl],
      maxPrices: [370n * USD], // the owner will pay at most $370 a share
      deposit: 50n * USD,
    });
    const receipt = await tx.wait();
    const created = receipt!.logs.map((l: any) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "GovernorCreated");
    const governor = await ethers.getContractAt("QuaestorStockGovernor", created!.args.governor);
    // Chainlink's AAPL price, a 1% margin, and three days' staleness so a weekend does not stop it.
    await governor.connect(owner).setPriceGuard(RH.aapl, RH.aaplFeed, 100, 3 * DAY);
    return { factory, governor, owner, operator, attacker };
  }

  async function quote(fee: number, amountIn: bigint) {
    const quoter = new ethers.Contract(RH.quoterV2, [
      "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
    ], ethers.provider);
    const [out] = await quoter.quoteExactInputSingle.staticCall({ tokenIn: RH.usdg, tokenOut: RH.aapl, amountIn, fee, sqrtPriceLimitX96: 0 });
    return out as bigint;
  }

  /** The attacker's own AAPL pool on the real Uniswap factory, at a price it chose. */
  async function attackerPool(usdPerShare: bigint) {
    const factory = new ethers.Contract(RH.v3Factory, [
      "function createPool(address,address,uint24) returns (address)",
      "function getPool(address,address,uint24) view returns (address)",
    ], (await ethers.getSigners())[2]);
    const fee = 100; // AAPL/USDG has no 0.01% pool, so the attacker can open one
    expect(await factory.getPool(RH.usdg, RH.aapl, fee)).to.equal(ethers.ZeroAddress);
    await (await factory.createPool(RH.usdg, RH.aapl, fee)).wait();
    const poolAddr = await factory.getPool(RH.usdg, RH.aapl, fee);
    const pool = new ethers.Contract(poolAddr, ["function initialize(uint160)", "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"], (await ethers.getSigners())[2]);
    // token0 is USDG (lower address), token1 is AAPL: price = AAPL wei per USDG unit.
    // At P dollars a share, 1e6 USDG units buy 1e18/P wei, so the ratio is 1e12/P.
    const ratio = 10n ** 12n / usdPerShare;
    const sqrt = (n: bigint) => { let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
    await (await pool.initialize(sqrt(ratio) * (1n << 96n))).wait();
    const [, tick] = await pool.slot0();

    const helper = await (await ethers.getContractFactory("UniV3LiquidityHelper")).deploy();
    await erc20(RH.usdg, await impersonate(RH.usdgHolder)).transfer(await helper.getAddress(), 1_000n * USD);
    await erc20(RH.aapl, await impersonate(RH.aaplHolder)).transfer(await helper.getAddress(), 10n ** 16n);
    const t = Number(tick);
    await (await helper.seed(poolAddr, t - 400, t + 400, 10n ** 12n)).wait();
    return { poolAddr, fee };
  }

  it("is forked from Robinhood Chain, with USDG, AAPL, Uniswap and Chainlink really there", async () => {
    expect((await ethers.provider.getNetwork()).chainId).to.equal(4663n);
    for (const a of [RH.usdg, RH.aapl, RH.swapRouter02, RH.quoterV2, RH.aaplFeed]) {
      expect(await ethers.provider.getCode(a)).to.not.equal("0x");
    }
  });

  it("buys real AAPL through Uniswap: the governor holds it, and pays what QuoterV2 said", async () => {
    const { governor, operator } = await deploy();
    const gov = await governor.getAddress();
    const amountIn = 5n * USD;
    const quoted = await quote(RH.fee, amountIn);
    const minOut = (quoted * 99n) / 100n;

    await governor.connect(operator).executeTrade({
      intentId: ethers.id("fork-buy-1"),
      venue: RH.swapRouter02,
      tokenOut: RH.aapl,
      amountIn,
      minOut,
      decisionHash: ethers.id("buy 5 USDG of AAPL on the 0.05% pool"),
      swapData: exactInputSingle(RH.fee, gov, amountIn, minOut),
    });

    expect(await erc20(RH.aapl).balanceOf(gov)).to.equal(quoted);
    expect(await erc20(RH.usdg).balanceOf(gov)).to.equal(45n * USD);
    expect(await governor.spentInEpoch()).to.equal(amountIn);
    // Uniswap's router was lent exactly the trade, and the governor took it back.
    const allowance = new ethers.Contract(RH.usdg, ["function allowance(address,address) view returns (uint256)"], ethers.provider);
    expect(await allowance.allowance(gov, RH.swapRouter02)).to.equal(0);
  });

  it("reverts a real Uniswap route that sends the shares to someone else", async () => {
    const { governor, operator, attacker } = await deploy();
    const amountIn = 5n * USD;
    const quoted = await quote(RH.fee, amountIn);
    await expect(governor.connect(operator).executeTrade({
      intentId: ethers.id("fork-redirect"),
      venue: RH.swapRouter02,
      tokenOut: RH.aapl,
      amountIn,
      minOut: quoted / 2n,
      decisionHash: ethers.ZeroHash,
      swapData: exactInputSingle(RH.fee, attacker.address, amountIn, 1n),
    })).to.be.revertedWithCustomError(governor, "MinimumOutputNotMet").withArgs(0, quoted / 2n);
  });

  it("a hijacked agent routes through its attacker's own real pool: Uniswap fills, the limit price reverts it", async () => {
    const { governor, operator } = await deploy();
    const { fee } = await attackerPool(1_000_000n); // a million dollars a share
    const gov = await governor.getAddress();
    const call = {
      intentId: ethers.id("fork-hijack"),
      venue: RH.swapRouter02, // the router the owner approved
      tokenOut: RH.aapl,
      amountIn: 1n * USD,
      minOut: 1n, // the hijacked agent's floor: one wei
      decisionHash: ethers.id("newsletter says buy now"),
      swapData: exactInputSingle(fee, gov, 1n * USD, 1n),
    };
    // PriceAboveLimit is raised after the venue call returned and the balances
    // were read, so Uniswap's swap itself succeeded: the measurement stopped it.
    await expect(governor.connect(operator).executeTrade(call)).to.be.revertedWithCustomError(governor, "PriceAboveLimit");
  });

  it("with no limit price set, Chainlink's AAPL price catches the same pool", async () => {
    const { governor, owner, operator } = await deploy();
    await governor.connect(owner).setPriceLimit(RH.aapl, 0);
    const { fee } = await attackerPool(1_000_000n);
    const gov = await governor.getAddress();
    await expect(governor.connect(operator).executeTrade({
      intentId: ethers.id("fork-hijack-oracle"),
      venue: RH.swapRouter02,
      tokenOut: RH.aapl,
      amountIn: 1n * USD,
      minOut: 1n,
      decisionHash: ethers.ZeroHash,
      swapData: exactInputSingle(fee, gov, 1n * USD, 1n),
    })).to.be.revertedWithCustomError(governor, "FillAboveOracle");
  });
});
