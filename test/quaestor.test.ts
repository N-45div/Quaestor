import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const DATA = 0;
const INFERENCE = 1;
const EXECUTION = 2;

const DAY = 24 * 60 * 60;
const eth = (v: string) => ethers.parseEther(v);

describe("Quaestor stack", () => {
  async function deployFixture() {
    const [deployer, owner, operator, payee, rando] = await ethers.getSigners();

    const dex = await ethers.deployContract("QuaestorDEX");
    const qusd = await ethers.deployContract("TestToken", [
      "Quaestor USD",
      "qUSD",
      eth("1000"), // faucet drip
    ]);

    // Seed a real pool: 100 OKB : 10,000 qUSD (spot 1 OKB = 100 qUSD)
    await qusd.mint(deployer.address, eth("10000"));
    await qusd.approve(await dex.getAddress(), eth("10000"));
    await dex.addLiquidity(await qusd.getAddress(), eth("10000"), {
      value: eth("100"),
    });

    const quaestor = await ethers.deployContract("Quaestor", [
      await dex.getAddress(),
    ]);

    const policies = {
      data: { epochCap: eth("1"), perCallCap: eth("0.1") },
      inference: { epochCap: eth("2"), perCallCap: eth("0.5") },
      execution: { epochCap: eth("5"), perCallCap: eth("2") },
    };

    const agentId = 1n;
    await quaestor
      .connect(owner)
      .registerAgent(
        operator.address,
        DAY,
        "ipfs://agent-manifest",
        policies.data,
        policies.inference,
        policies.execution,
        { value: eth("10") }
      );

    return {
      quaestor,
      dex,
      qusd,
      deployer,
      owner,
      operator,
      payee,
      rando,
      agentId,
      policies,
    };
  }

  // =============================================================== governor

  describe("registration & treasury", () => {
    it("registers an agent with policies and initial deposit", async () => {
      const { quaestor, owner, operator, agentId } = await loadFixture(deployFixture);

      const info = await quaestor.agents(agentId);
      expect(info.owner).to.equal(owner.address);
      expect(info.operator).to.equal(operator.address);
      expect(info.suspended).to.equal(false);
      expect(info.epochLength).to.equal(DAY);
      expect(await quaestor.balanceOf(agentId)).to.equal(eth("10"));

      const dataPolicy = await quaestor.policyOf(agentId, DATA);
      expect(dataPolicy.epochCap).to.equal(eth("1"));
      expect(dataPolicy.perCallCap).to.equal(eth("0.1"));
    });

    it("lets anyone top up a treasury, and only the owner withdraw", async () => {
      const { quaestor, owner, rando, agentId } = await loadFixture(deployFixture);

      await expect(
        quaestor.connect(rando).deposit(agentId, { value: eth("1") })
      ).to.emit(quaestor, "Deposited");
      expect(await quaestor.balanceOf(agentId)).to.equal(eth("11"));

      await expect(
        quaestor.connect(rando).withdraw(agentId, eth("1"), rando.address)
      ).to.be.revertedWithCustomError(quaestor, "NotOwner");

      await expect(
        quaestor.connect(owner).withdraw(agentId, eth("11"), owner.address)
      ).to.changeEtherBalance(owner, eth("11"));
      expect(await quaestor.balanceOf(agentId)).to.equal(0n);
    });

    it("rejects registration with zero operator or zero epoch", async () => {
      const { quaestor, owner, operator } = await loadFixture(deployFixture);
      const p = { epochCap: 1n, perCallCap: 1n };

      await expect(
        quaestor.connect(owner).registerAgent(ethers.ZeroAddress, DAY, "", p, p, p)
      ).to.be.revertedWithCustomError(quaestor, "ZeroAddress");
      await expect(
        quaestor.connect(owner).registerAgent(operator.address, 0, "", p, p, p)
      ).to.be.revertedWithCustomError(quaestor, "ZeroAmount");
    });
  });

  describe("pay (DATA / INFERENCE)", () => {
    it("settles an in-budget payment and emits a Receipt", async () => {
      const { quaestor, operator, payee, agentId } = await loadFixture(deployFixture);
      const metaHash = ethers.keccak256(ethers.toUtf8Bytes("price-feed call #1"));

      const tx = quaestor
        .connect(operator)
        .pay(agentId, DATA, payee.address, eth("0.05"), metaHash);

      await expect(tx).to.changeEtherBalance(payee, eth("0.05"));
      await expect(tx)
        .to.emit(quaestor, "Receipt")
        .withArgs(agentId, DATA, payee.address, eth("0.05"), metaHash, 0n, eth("0.05"));

      expect(await quaestor.balanceOf(agentId)).to.equal(eth("9.95"));
      expect(await quaestor.spentIn(agentId, DATA, 0)).to.equal(eth("0.05"));
    });

    it("only the operator can spend — not even the owner", async () => {
      const { quaestor, owner, payee, agentId } = await loadFixture(deployFixture);
      await expect(
        quaestor.connect(owner).pay(agentId, DATA, payee.address, eth("0.01"), ethers.ZeroHash)
      ).to.be.revertedWithCustomError(quaestor, "NotOperator");
    });

    it("enforces the per-call cap", async () => {
      const { quaestor, operator, payee, agentId } = await loadFixture(deployFixture);
      await expect(
        quaestor.connect(operator).pay(agentId, DATA, payee.address, eth("0.2"), ethers.ZeroHash)
      )
        .to.be.revertedWithCustomError(quaestor, "PerCallCapExceeded")
        .withArgs(eth("0.2"), eth("0.1"));
    });

    it("enforces the epoch cap across many calls", async () => {
      const { quaestor, operator, payee, agentId } = await loadFixture(deployFixture);
      // 10 x 0.1 exhausts the 1 OKB DATA epoch cap
      for (let i = 0; i < 10; i++) {
        await quaestor
          .connect(operator)
          .pay(agentId, DATA, payee.address, eth("0.1"), ethers.ZeroHash);
      }
      await expect(
        quaestor.connect(operator).pay(agentId, DATA, payee.address, eth("0.1"), ethers.ZeroHash)
      ).to.be.revertedWithCustomError(quaestor, "EpochCapExceeded");
    });

    it("budgets are per-category — DATA exhaustion leaves INFERENCE intact", async () => {
      const { quaestor, operator, payee, agentId } = await loadFixture(deployFixture);
      for (let i = 0; i < 10; i++) {
        await quaestor
          .connect(operator)
          .pay(agentId, DATA, payee.address, eth("0.1"), ethers.ZeroHash);
      }
      await expect(
        quaestor
          .connect(operator)
          .pay(agentId, INFERENCE, payee.address, eth("0.5"), ethers.ZeroHash)
      ).to.emit(quaestor, "Receipt");
    });

    it("resets the budget at the epoch boundary", async () => {
      const { quaestor, operator, payee, agentId } = await loadFixture(deployFixture);
      for (let i = 0; i < 10; i++) {
        await quaestor
          .connect(operator)
          .pay(agentId, DATA, payee.address, eth("0.1"), ethers.ZeroHash);
      }
      await time.increase(DAY);
      await expect(
        quaestor.connect(operator).pay(agentId, DATA, payee.address, eth("0.1"), ethers.ZeroHash)
      ).to.emit(quaestor, "Receipt");
      expect(await quaestor.currentEpoch(agentId)).to.equal(1n);
      expect(await quaestor.spentIn(agentId, DATA, 1)).to.equal(eth("0.1"));
    });

    it("cannot route EXECUTION through pay()", async () => {
      const { quaestor, operator, payee, agentId } = await loadFixture(deployFixture);
      await expect(
        quaestor
          .connect(operator)
          .pay(agentId, EXECUTION, payee.address, eth("0.1"), ethers.ZeroHash)
      ).to.be.revertedWithCustomError(quaestor, "InvalidCategory");
    });

    it("cannot spend more than the treasury holds", async () => {
      const { quaestor, owner, operator, payee, agentId } = await loadFixture(deployFixture);
      await quaestor.connect(owner).withdraw(agentId, eth("9.99"), owner.address);
      await expect(
        quaestor.connect(operator).pay(agentId, DATA, payee.address, eth("0.05"), ethers.ZeroHash)
      ).to.be.revertedWithCustomError(quaestor, "InsufficientTreasury");
    });
  });

  describe("swap (EXECUTION) through the real AMM", () => {
    it("executes a governed swap at pool price and delivers tokens to the owner", async () => {
      const { quaestor, dex, qusd, owner, operator, agentId } =
        await loadFixture(deployFixture);
      const t = await qusd.getAddress();
      const metaHash = ethers.keccak256(ethers.toUtf8Bytes("DCA buy #1"));

      const expectedOut = await dex.getNativeToTokenOut(t, eth("1"));
      // 100:10000 pool, 1 OKB in with 0.3% fee → a bit under the no-fee 99.0099
      expect(expectedOut).to.be.gt(eth("98"));
      expect(expectedOut).to.be.lt(eth("99.01"));

      const tx = quaestor.connect(operator).swap(agentId, eth("1"), expectedOut, t, metaHash);
      await expect(tx)
        .to.emit(quaestor, "SwapExecuted")
        .withArgs(agentId, t, eth("1"), expectedOut);

      expect(await qusd.balanceOf(owner.address)).to.equal(expectedOut);
      expect(await quaestor.balanceOf(agentId)).to.equal(eth("9"));
      expect(await quaestor.spentIn(agentId, EXECUTION, 0)).to.equal(eth("1"));

      const pool = await dex.pools(t);
      expect(pool.reserveNative).to.equal(eth("101"));
      expect(pool.reserveToken).to.equal(eth("10000") - expectedOut);
    });

    it("enforces EXECUTION per-call and epoch caps", async () => {
      const { quaestor, qusd, operator, agentId } = await loadFixture(deployFixture);
      const t = await qusd.getAddress();

      await expect(
        quaestor.connect(operator).swap(agentId, eth("3"), 0, t, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(quaestor, "PerCallCapExceeded");

      // 2 + 2 + 2 would breach the 5 OKB epoch cap on the third swap
      await quaestor.connect(operator).swap(agentId, eth("2"), 0, t, ethers.ZeroHash);
      await quaestor.connect(operator).swap(agentId, eth("2"), 0, t, ethers.ZeroHash);
      await expect(
        quaestor.connect(operator).swap(agentId, eth("2"), 0, t, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(quaestor, "EpochCapExceeded");
    });

    it("respects the agent's minOut (slippage guard)", async () => {
      const { quaestor, dex, qusd, operator, agentId } = await loadFixture(deployFixture);
      const t = await qusd.getAddress();
      const expectedOut = await dex.getNativeToTokenOut(t, eth("1"));
      await expect(
        quaestor.connect(operator).swap(agentId, eth("1"), expectedOut + 1n, t, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(dex, "SlippageExceeded");
    });
  });

  describe("kill-switch", () => {
    it("suspend freezes pay and swap; resume restores both", async () => {
      const { quaestor, qusd, owner, operator, payee, agentId } =
        await loadFixture(deployFixture);
      const t = await qusd.getAddress();

      await expect(quaestor.connect(owner).suspend(agentId)).to.emit(quaestor, "Suspended");

      await expect(
        quaestor.connect(operator).pay(agentId, DATA, payee.address, eth("0.05"), ethers.ZeroHash)
      ).to.be.revertedWithCustomError(quaestor, "AgentIsSuspended");
      await expect(
        quaestor.connect(operator).swap(agentId, eth("1"), 0, t, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(quaestor, "AgentIsSuspended");

      await quaestor.connect(owner).resume(agentId);
      await expect(
        quaestor.connect(operator).pay(agentId, DATA, payee.address, eth("0.05"), ethers.ZeroHash)
      ).to.emit(quaestor, "Receipt");
    });

    it("only the owner holds the kill-switch", async () => {
      const { quaestor, operator, rando, agentId } = await loadFixture(deployFixture);
      await expect(
        quaestor.connect(operator).suspend(agentId)
      ).to.be.revertedWithCustomError(quaestor, "NotOwner");
      await expect(
        quaestor.connect(rando).suspend(agentId)
      ).to.be.revertedWithCustomError(quaestor, "NotOwner");
    });
  });

  describe("views", () => {
    it("remainingBudget is bounded by both the epoch cap and the treasury", async () => {
      const { quaestor, owner, operator, payee, agentId } = await loadFixture(deployFixture);

      expect(await quaestor.remainingBudget(agentId, DATA)).to.equal(eth("1"));

      await quaestor
        .connect(operator)
        .pay(agentId, DATA, payee.address, eth("0.1"), ethers.ZeroHash);
      expect(await quaestor.remainingBudget(agentId, DATA)).to.equal(eth("0.9"));

      // Drain treasury below the remaining cap
      await quaestor.connect(owner).withdraw(agentId, eth("9.5"), owner.address);
      expect(await quaestor.remainingBudget(agentId, DATA)).to.equal(eth("0.4"));
    });
  });

  // ==================================================================== dex

  describe("QuaestorDEX", () => {
    it("prices swaps by constant product and moves the price", async () => {
      const { dex, qusd, rando } = await loadFixture(deployFixture);
      const t = await qusd.getAddress();

      const spotBefore = await dex.spotPrice(t);
      expect(spotBefore).to.equal(eth("100"));

      const out = await dex.getNativeToTokenOut(t, eth("10"));
      // no-fee bound: 10000*10/110 = 909.09; with fee slightly less
      expect(out).to.be.lt(eth("909.1"));
      expect(out).to.be.gt(eth("900"));

      await dex.connect(rando).swapExactNativeForTokens(out, t, rando.address, {
        value: eth("10"),
      });
      expect(await qusd.balanceOf(rando.address)).to.equal(out);
      expect(await dex.spotPrice(t)).to.be.lt(spotBefore); // OKB got cheaper in qUSD
    });

    it("supports round-trips: token back to native", async () => {
      const { dex, qusd, rando } = await loadFixture(deployFixture);
      const t = await qusd.getAddress();

      await qusd.connect(rando).faucet();
      await qusd.connect(rando).approve(await dex.getAddress(), eth("1000"));

      const expected = await dex.getTokenToNativeOut(t, eth("500"));
      await expect(
        dex.connect(rando).swapExactTokensForNative(t, eth("500"), expected, rando.address)
      ).to.changeEtherBalance(rando, expected);
    });

    it("joins liquidity at pool ratio and lets providers exit", async () => {
      const { dex, qusd, rando } = await loadFixture(deployFixture);
      const t = await qusd.getAddress();

      await qusd.connect(rando).faucet();
      await qusd.connect(rando).approve(await dex.getAddress(), eth("1000"));

      // Pool is 100:10000 → 1 OKB pairs with 100 qUSD
      await dex.connect(rando).addLiquidity(t, eth("1000"), { value: eth("1") });
      const shares = await dex.sharesOf(t, rando.address);
      expect(shares).to.be.gt(0n);
      expect(await qusd.balanceOf(rando.address)).to.equal(eth("900"));

      const [nativeOut, tokenOut] = await dex
        .connect(rando)
        .removeLiquidity.staticCall(t, shares, rando.address);
      expect(nativeOut).to.be.closeTo(eth("1"), eth("0.001"));
      expect(tokenOut).to.be.closeTo(eth("100"), eth("0.1"));
      await dex.connect(rando).removeLiquidity(t, shares, rando.address);
      expect(await dex.sharesOf(t, rando.address)).to.equal(0n);
    });

    it("faucet drips once per hour", async () => {
      const { qusd, rando } = await loadFixture(deployFixture);
      await qusd.connect(rando).faucet();
      expect(await qusd.balanceOf(rando.address)).to.equal(eth("1000"));
      await expect(qusd.connect(rando).faucet()).to.be.revertedWithCustomError(
        qusd,
        "FaucetCooldown"
      );
      await time.increase(3601);
      await qusd.connect(rando).faucet();
      expect(await qusd.balanceOf(rando.address)).to.equal(eth("2000"));
    });
  });
});
