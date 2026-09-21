import { expect } from "chai";
import { ethers, network } from "hardhat";

/**
 * The governor against the real Uniswap, on a fork of Base mainnet.
 *
 * The mock venues prove the rules; only this proves the rules hold against a
 * contract nobody here wrote. It runs with `FORK_BASE=1`, and skips itself
 * otherwise, because it needs a live archive endpoint.
 *
 *   FORK_BASE=1 npx hardhat test test/quaestor-v2-base-fork.test.ts
 */
const BASE = {
  swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  // Verified on 21 Sep 2026: the deepest ETH/USDC pool on Base by WETH held.
  fee: 3000,
};

const EXECUTION = 2;
const ONE_ETH = 10n ** 18n;

/** SwapRouter02.exactInputSingle, which wraps the ether it is sent. */
const exactInputSingle = (recipient: string, amountIn: bigint, minOut: bigint) =>
  new ethers.Interface([
    "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  ]).encodeFunctionData("exactInputSingle", [{
    tokenIn: BASE.weth,
    tokenOut: BASE.usdc,
    fee: BASE.fee,
    recipient,
    amountIn,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0,
  }]);

(process.env.FORK_BASE ? describe : describe.skip)("QuaestorV2 against the real Uniswap on Base", () => {
  const usdc = () => new ethers.Contract(BASE.usdc, ["function balanceOf(address) view returns (uint256)"], ethers.provider);

  async function deploy() {
    const [owner, operator] = await ethers.getSigners();
    const governor = await (await ethers.getContractFactory("QuaestorV2")).deploy();
    await governor.connect(owner).registerAgent(operator.address, 86_400, "ipfs://agent", { value: ONE_ETH });
    // A tenth of an ether a trade, a quarter a day.
    await governor.connect(owner).setPolicy(1, EXECUTION, ONE_ETH / 4n, ONE_ETH / 10n);
    await governor.connect(owner).setVenue(1, BASE.swapRouter02, true);
    await governor.connect(owner).setInstrument(1, BASE.usdc, true);
    return { governor, owner, operator };
  }

  it("is forked from Base mainnet, with Uniswap's router really there", async () => {
    expect((await ethers.provider.getNetwork()).chainId).to.equal(8453n);
    expect(await ethers.provider.getCode(BASE.swapRouter02)).to.not.equal("0x");
    expect(await ethers.provider.getCode(BASE.usdc)).to.not.equal("0x");
  });

  it("buys USDC through Uniswap, and the owner is the one who receives it", async () => {
    const { governor, owner, operator } = await deploy();
    const amountIn = ONE_ETH / 100n; // 0.01 ETH
    const before = await usdc().balanceOf(owner.address);

    await governor.connect(operator).swap(
      1, BASE.swapRouter02, exactInputSingle(owner.address, amountIn, 1n),
      BASE.usdc, amountIn, 1n, ethers.id("real-uniswap"),
    );

    const received = (await usdc().balanceOf(owner.address)) - before;
    // 0.01 ETH is tens of dollars, whatever the day's price.
    expect(received).to.be.greaterThan(10_000_000n);
    expect(await governor.balanceOf(1)).to.equal(ONE_ETH - amountIn);
    expect(await governor.spentIn(1, EXECUTION, 0)).to.equal(amountIn);
  });

  it("reverts when Uniswap would deliver less than the intent demanded", async () => {
    const { governor, owner, operator } = await deploy();
    const amountIn = ONE_ETH / 100n;
    // A floor of 100,000 USDC for 0.01 ETH. Uniswap's own check fails first,
    // and the governor's would have caught it either way.
    await expect(
      governor.connect(operator).swap(
        1, BASE.swapRouter02, exactInputSingle(owner.address, amountIn, 100_000n * 10n ** 6n),
        BASE.usdc, amountIn, 100_000n * 10n ** 6n, ethers.id("too-much"),
      ),
    ).to.be.revertedWithCustomError(governor, "VenueCallFailed");
    expect(await governor.balanceOf(1)).to.equal(ONE_ETH);
  });

  it("reverts when the route sends the USDC to someone other than the owner", async () => {
    const { governor, operator } = await deploy();
    const amountIn = ONE_ETH / 100n;
    const elsewhere = ethers.Wallet.createRandom().address;
    // Uniswap does exactly as it is told and the swap itself succeeds. The
    // governor measures the owner's balance, which did not move, and reverts.
    await expect(
      governor.connect(operator).swap(
        1, BASE.swapRouter02, exactInputSingle(elsewhere, amountIn, 1n),
        BASE.usdc, amountIn, 1n, ethers.id("wrong-recipient"),
      ),
    ).to.be.revertedWithCustomError(governor, "MinimumOutputNotMet");
    expect(await usdc().balanceOf(elsewhere)).to.equal(0);
    expect(await governor.balanceOf(1)).to.equal(ONE_ETH);
  });

  it("refuses Uniswap itself once the owner takes it off the allowlist", async () => {
    const { governor, owner, operator } = await deploy();
    await governor.connect(owner).setVenue(1, BASE.swapRouter02, false);
    const amountIn = ONE_ETH / 100n;
    await expect(
      governor.connect(operator).swap(
        1, BASE.swapRouter02, exactInputSingle(owner.address, amountIn, 1n),
        BASE.usdc, amountIn, 1n, ethers.id("revoked"),
      ),
    ).to.be.revertedWithCustomError(governor, "VenueNotAllowed");
  });

  it("holds the cap against Uniswap as firmly as against a mock", async () => {
    const { governor, owner, operator } = await deploy();
    const overCap = ONE_ETH / 5n; // twice the per-trade cap
    await expect(
      governor.connect(operator).swap(
        1, BASE.swapRouter02, exactInputSingle(owner.address, overCap, 1n),
        BASE.usdc, overCap, 1n, ethers.id("over-cap"),
      ),
    ).to.be.revertedWithCustomError(governor, "PerCallCapExceeded");
  });

  after(async () => {
    if (process.env.FORK_BASE) await network.provider.send("hardhat_reset");
  });
});
