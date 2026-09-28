import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * The Stock Token governor (contracts/QuaestorStocks.sol) against routes that lie.
 *
 * These mirror the Solana program's suite (solana/tests/governor.test.ts) case
 * for case where the EVM has the same hazard, and add the ones only an ERC-20
 * approval has: an allowance left behind, a venue that pulls twice, a route
 * that reaches into another agent's governor.
 */
describe("QuaestorStocks — the Stock Token governor", () => {
  const USD = 10n ** 6n; // USDG has 6 decimals
  const SHARE = 10n ** 18n; // Stock Tokens have 18
  const PRICE = 334_490_000n; // $334.49 a share, in budget base units
  const LIMIT = 370n * USD; // the owner's limit price
  const DAY = 86_400;

  const label = (s: string) => ethers.zeroPadBytes(ethers.toUtf8Bytes(s), 16);
  const venueIface = new ethers.Interface(["function buy(address budget, address stock, uint256 amountIn)"]);
  const Mode = { Honest: 0, KeepMoney: 1, Short: 2, Redirect: 3, KeepChange: 4, OverRefund: 5, OverPull: 6, SweepShares: 7, Reenter: 8, OtherToken: 9, RaidOther: 10 };

  async function deploy(opts: { budgetToken?: "usdg" | "sticky" } = {}) {
    const [owner, operator, guardian, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const usdg = opts.budgetToken === "sticky"
      ? await (await ethers.getContractFactory("StickyAllowanceToken")).deploy()
      : await Token.deploy("Global Dollar", "USDG", 6);
    const stock = await Token.deploy("Apple Stock Token", "AAPL", 18);
    const other = await Token.deploy("Other Stock Token", "OTHR", 18);
    const venue = await (await ethers.getContractFactory("MockStockVenue")).deploy();
    await venue.setPrice(PRICE);
    const factory = await (await ethers.getContractFactory("QuaestorStocks")).deploy();

    await usdg.mint(owner.address, 1_000n * USD);
    await usdg.connect(owner).approve(await factory.getAddress(), 1_000n * USD);
    const governor = await createGovernor(factory, owner, {
      operator: operator.address,
      budgetToken: await usdg.getAddress(),
      venues: [await venue.getAddress()],
      tokens: [await stock.getAddress()],
      deposit: 50n * USD,
    });
    return { factory, governor, usdg, stock, other, venue, owner, operator, guardian, outsider };
  }

  async function createGovernor(
    factory: any,
    owner: any,
    s: { operator: string; budgetToken: string; venues: string[]; tokens: string[]; deposit: bigint; maxPrices?: bigint[] },
  ) {
    const tx = await factory.connect(owner).createGovernor({
      operator: s.operator,
      budgetToken: s.budgetToken,
      epochLength: DAY,
      perTradeCap: 5n * USD,
      epochCap: 20n * USD,
      venues: s.venues,
      labels: s.venues.map(() => label("uniswap-v3")),
      tokens: s.tokens,
      maxPrices: s.maxPrices ?? s.tokens.map(() => LIMIT),
      deposit: s.deposit,
    });
    const receipt = await tx.wait();
    const created = receipt.logs.map((l: any) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "GovernorCreated");
    return ethers.getContractAt("QuaestorStockGovernor", created.args.governor);
  }

  async function trade(
    ctx: Awaited<ReturnType<typeof deploy>>,
    t: { amountIn?: bigint; minOut?: bigint; intentId?: string; venue?: string; tokenOut?: string; pull?: bigint; signer?: any } = {},
  ) {
    const amountIn = t.amountIn ?? 5n * USD;
    const venue = t.venue ?? (await ctx.venue.getAddress());
    const tokenOut = t.tokenOut ?? (await ctx.stock.getAddress());
    const swapData = venueIface.encodeFunctionData("buy", [await ctx.usdg.getAddress(), await ctx.stock.getAddress(), t.pull ?? amountIn]);
    return ctx.governor.connect(t.signer ?? ctx.operator).executeTrade({
      intentId: t.intentId ?? ethers.hexlify(ethers.randomBytes(32)),
      venue,
      tokenOut,
      amountIn,
      minOut: t.minOut ?? 1n,
      decisionHash: ethers.id("buy AAPL: under my limit, inside my caps"),
      swapData,
    });
  }

  const sharesFor = (paid: bigint) => (paid * SHARE) / PRICE;

  describe("balance postconditions", () => {
    it("settles a route that honours its floor, holds the shares, and records what it cost", async () => {
      const ctx = await deploy();
      const gov = await ctx.governor.getAddress();
      const expected = sharesFor(5n * USD);
      await expect(trade(ctx, { minOut: expected }))
        .to.emit(ctx.governor, "TradeExecuted")
        .withArgs(anyValue(), await ctx.venue.getAddress(), await ctx.stock.getAddress(), 5n * USD, expected, ethers.id("buy AAPL: under my limit, inside my caps"), anyValue(), 5n * USD);
      expect(await ctx.stock.balanceOf(gov)).to.equal(expected);
      expect(await ctx.usdg.balanceOf(gov)).to.equal(45n * USD);
      expect(await ctx.governor.spentInEpoch()).to.equal(5n * USD);
      expect(await ctx.governor.remainingBudget()).to.equal(15n * USD);
    });

    it("reverts a route that delivers under the agent's floor", async () => {
      const ctx = await deploy();
      await ctx.venue.setMode(Mode.Short);
      const floor = sharesFor(5n * USD);
      await expect(trade(ctx, { minOut: floor })).to.be.revertedWithCustomError(ctx.governor, "MinimumOutputNotMet").withArgs(floor / 2n, floor);
      expect(await ctx.usdg.balanceOf(await ctx.governor.getAddress())).to.equal(50n * USD);
    });

    it("reverts a route that takes the money and delivers nothing", async () => {
      const ctx = await deploy();
      await ctx.venue.setMode(Mode.KeepMoney);
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "MinimumOutputNotMet").withArgs(0, 1);
      expect(await ctx.governor.spentInEpoch()).to.equal(0);
    });

    it("reverts a route that sends the shares somewhere else", async () => {
      const ctx = await deploy();
      await ctx.venue.setMode(Mode.Redirect);
      await ctx.venue.setRedirect(ctx.outsider.address);
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "MinimumOutputNotMet");
      expect(await ctx.stock.balanceOf(ctx.outsider.address)).to.equal(0);
    });

    it("reverts a route that delivers a different token than the one bought", async () => {
      const ctx = await deploy();
      await ctx.venue.setMode(Mode.OtherToken);
      await ctx.venue.setOtherToken(await ctx.other.getAddress());
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "MinimumOutputNotMet");
    });

    it("lends the venue exactly the trade's amount: pulling more fails inside the venue", async () => {
      const ctx = await deploy();
      await ctx.venue.setMode(Mode.OverPull);
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "VenueCallFailed");
      expect(await ctx.usdg.balanceOf(await ctx.governor.getAddress())).to.equal(50n * USD);
    });

    it("never approves a share, so a route cannot sell what the agent already holds", async () => {
      const ctx = await deploy();
      await trade(ctx);
      const held = await ctx.stock.balanceOf(await ctx.governor.getAddress());
      await ctx.venue.setMode(Mode.SweepShares);
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "VenueCallFailed");
      expect(await ctx.stock.balanceOf(await ctx.governor.getAddress())).to.equal(held);
      expect(await ctx.stock.allowance(await ctx.governor.getAddress(), await ctx.venue.getAddress())).to.equal(0);
    });

    it("reverts a route that hands back more of the budget than it took", async () => {
      const ctx = await deploy();
      await ctx.usdg.mint(await ctx.venue.getAddress(), 1n);
      await ctx.venue.setMode(Mode.OverRefund);
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "VaultBalanceIncreased");
    });

    it("charges the epoch what the route took, not what it was allowed to take", async () => {
      const ctx = await deploy();
      await ctx.venue.setMode(Mode.KeepChange);
      await ctx.venue.setChangeBack(1n * USD);
      await trade(ctx);
      expect(await ctx.governor.spentInEpoch()).to.equal(4n * USD);
      expect(await ctx.usdg.balanceOf(await ctx.governor.getAddress())).to.equal(46n * USD);
    });

    it("takes the approval back after every trade, even one the venue under-spent", async () => {
      const ctx = await deploy();
      await trade(ctx, { pull: 4n * USD });
      expect(await ctx.usdg.allowance(await ctx.governor.getAddress(), await ctx.venue.getAddress())).to.equal(0);
      expect(await ctx.governor.spentInEpoch()).to.equal(4n * USD);
    });

    it("refuses to finish when the budget token will not let the approval go", async () => {
      const ctx = await deploy({ budgetToken: "sticky" });
      await expect(trade(ctx, { pull: 4n * USD })).to.be.revertedWithCustomError(ctx.governor, "AllowanceLeftBehind").withArgs(1n * USD);
    });

    it("stops a route calling back into the governor mid-trade", async () => {
      const ctx = await deploy();
      const inner = ctx.governor.interface.encodeFunctionData("withdraw", [await ctx.usdg.getAddress(), 1n, ctx.outsider.address]);
      await ctx.venue.setMode(Mode.Reenter);
      await ctx.venue.setReentry(inner);
      const tx = trade(ctx);
      await expect(tx).to.be.revertedWithCustomError(ctx.governor, "VenueCallFailed");
    });

    it("keeps each agent's money in its own governor: a route cannot reach another's", async () => {
      const ctx = await deploy();
      const second = await createGovernor(ctx.factory, ctx.owner, {
        operator: ctx.outsider.address,
        budgetToken: await ctx.usdg.getAddress(),
        venues: [],
        tokens: [],
        deposit: 30n * USD,
      });
      await ctx.venue.setMode(Mode.RaidOther);
      await ctx.venue.setRaidTarget(await second.getAddress());
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "VenueCallFailed");
      expect(await ctx.usdg.balanceOf(await second.getAddress())).to.equal(30n * USD);
    });
  });

  describe("policy", () => {
    it("refuses a second execution of the same intent id", async () => {
      const ctx = await deploy();
      const intentId = ethers.id("intent-1");
      await trade(ctx, { intentId });
      await expect(trade(ctx, { intentId })).to.be.revertedWithCustomError(ctx.governor, "IntentAlreadyExecuted").withArgs(intentId);
    });

    it("refuses to trade while suspended; a guardian can stop it but only the owner can restart it", async () => {
      const ctx = await deploy();
      await ctx.governor.connect(ctx.owner).setGuardian(ctx.guardian.address);
      await ctx.governor.connect(ctx.guardian).setSuspended(true);
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "Suspended");
      await expect(ctx.governor.connect(ctx.guardian).setSuspended(false)).to.be.revertedWithCustomError(ctx.governor, "NotOwner");
      await ctx.governor.connect(ctx.owner).setSuspended(false);
      await trade(ctx);
    });

    it("refuses an instrument the owner never approved", async () => {
      const ctx = await deploy();
      await expect(trade(ctx, { tokenOut: await ctx.other.getAddress() }))
        .to.be.revertedWithCustomError(ctx.governor, "InstrumentNotAllowed");
    });

    it("refuses a trade above the per-trade cap", async () => {
      const ctx = await deploy();
      await expect(trade(ctx, { amountIn: 6n * USD })).to.be.revertedWithCustomError(ctx.governor, "PerTradeCapExceeded").withArgs(6n * USD, 5n * USD);
    });

    it("refuses the trade that would breach the epoch cap, and allows it in the next epoch", async () => {
      const ctx = await deploy();
      for (let i = 0; i < 4; i++) await trade(ctx);
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "EpochCapExceeded").withArgs(25n * USD, 20n * USD);
      await time.increase(DAY);
      await trade(ctx);
      expect(await ctx.governor.spentInEpoch()).to.equal(5n * USD);
    });

    it("refuses a caller that is not the operator, the owner included", async () => {
      const ctx = await deploy();
      await expect(trade(ctx, { signer: ctx.outsider })).to.be.revertedWithCustomError(ctx.governor, "NotOperator");
      await expect(trade(ctx, { signer: ctx.owner })).to.be.revertedWithCustomError(ctx.governor, "NotOperator");
    });

    it("refuses a venue the owner never allowed, before any money moves", async () => {
      const ctx = await deploy();
      const rogue = await (await ethers.getContractFactory("MockStockVenue")).deploy();
      await expect(trade(ctx, { venue: await rogue.getAddress() })).to.be.revertedWithCustomError(ctx.governor, "VenueNotAllowed");
    });

    it("refuses a trade the budget cannot cover", async () => {
      const ctx = await deploy();
      await ctx.governor.connect(ctx.owner).withdraw(await ctx.usdg.getAddress(), 48n * USD, ctx.owner.address);
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "InsufficientBudget").withArgs(5n * USD, 2n * USD);
    });

    it("will not trade nothing, or without a floor to measure against", async () => {
      const ctx = await deploy();
      await expect(trade(ctx, { amountIn: 0n })).to.be.revertedWithCustomError(ctx.governor, "InvalidAmount");
      await expect(trade(ctx, { minOut: 0n })).to.be.revertedWithCustomError(ctx.governor, "InvalidMinimumOutput");
    });

    it("will not let the operator change its own limits", async () => {
      const ctx = await deploy();
      const g = ctx.governor.connect(ctx.operator);
      await expect(g.setPolicy(100n * USD, 1_000n * USD, DAY)).to.be.revertedWithCustomError(ctx.governor, "NotOwner");
      await expect(g.setVenue(ctx.outsider.address, true, label("x"))).to.be.revertedWithCustomError(ctx.governor, "NotOwner");
      await expect(g.setInstrument(await ctx.other.getAddress(), true, 0)).to.be.revertedWithCustomError(ctx.governor, "NotOwner");
      await expect(g.setPriceLimit(await ctx.stock.getAddress(), 0)).to.be.revertedWithCustomError(ctx.governor, "NotOwner");
      await expect(g.setOperator(ctx.outsider.address)).to.be.revertedWithCustomError(ctx.governor, "NotOwner");
      await expect(g.setSuspended(true)).to.be.revertedWithCustomError(ctx.governor, "NotGuardianOrOwner");
    });

    it("lets the owner change policy, and the next trade is measured against it", async () => {
      const ctx = await deploy();
      await ctx.governor.connect(ctx.owner).setPolicy(2n * USD, 20n * USD, DAY);
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "PerTradeCapExceeded").withArgs(5n * USD, 2n * USD);
      await trade(ctx, { amountIn: 2n * USD });
    });

    it("refuses a policy whose epoch cap is below its per-trade cap", async () => {
      const ctx = await deploy();
      await expect(ctx.governor.connect(ctx.owner).setPolicy(10n * USD, 5n * USD, DAY)).to.be.revertedWithCustomError(ctx.governor, "InvalidPolicy");
    });

    it("hands the agent's key to a new operator, and the old one can no longer trade", async () => {
      const ctx = await deploy();
      await ctx.governor.connect(ctx.owner).setOperator(ctx.outsider.address);
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "NotOperator");
      await trade(ctx, { signer: ctx.outsider });
    });
  });

  describe("venues", () => {
    it("holds several venues at once, each labelled on-chain", async () => {
      const ctx = await deploy();
      const second = await (await ethers.getContractFactory("MockStockVenue")).deploy();
      await second.setPrice(PRICE);
      await ctx.governor.connect(ctx.owner).setVenue(await second.getAddress(), true, label("uniswap-v4"));
      expect(ethers.toUtf8String(await ctx.governor.venueLabel(await ctx.venue.getAddress())).replace(/\0+$/, "")).to.equal("uniswap-v3");
      expect(ethers.toUtf8String(await ctx.governor.venueLabel(await second.getAddress())).replace(/\0+$/, "")).to.equal("uniswap-v4");
      await trade(ctx, { venue: await second.getAddress() });
      await trade(ctx);
    });

    it("stops routing through a venue the owner withdrew, and resumes when it returns", async () => {
      const ctx = await deploy();
      const v = await ctx.venue.getAddress();
      await ctx.governor.connect(ctx.owner).setVenue(v, false, label(""));
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "VenueNotAllowed").withArgs(v);
      await ctx.governor.connect(ctx.owner).setVenue(v, true, label("uniswap-v3"));
      await trade(ctx);
    });

    it("will not approve as a venue anything whose calldata could move tokens directly", async () => {
      const ctx = await deploy();
      const g = ctx.governor.connect(ctx.owner);
      for (const bad of [
        ctx.outsider.address, // no code: an EOA
        await ctx.governor.getAddress(),
        await ctx.usdg.getAddress(),
        await ctx.stock.getAddress(), // an approved share
        await ctx.factory.getAddress(),
      ]) {
        await expect(g.setVenue(bad, true, label("x"))).to.be.revertedWithCustomError(ctx.governor, "InvalidVenue").withArgs(bad);
      }
    });

    it("will not approve as a share the budget token, a venue, or an address with no code", async () => {
      const ctx = await deploy();
      const g = ctx.governor.connect(ctx.owner);
      for (const bad of [await ctx.usdg.getAddress(), await ctx.venue.getAddress(), ctx.outsider.address]) {
        await expect(g.setInstrument(bad, true, 0)).to.be.revertedWithCustomError(ctx.governor, "InvalidInstrument").withArgs(bad);
      }
    });
  });

  describe("taking a position out", () => {
    it("lets the owner take bought shares out of a suspended agent, even of a token since revoked", async () => {
      const ctx = await deploy();
      await trade(ctx);
      const held = await ctx.stock.balanceOf(await ctx.governor.getAddress());
      await ctx.governor.connect(ctx.owner).setSuspended(true);
      await ctx.governor.connect(ctx.owner).setInstrument(await ctx.stock.getAddress(), false, 0);
      await ctx.governor.connect(ctx.owner).withdraw(await ctx.stock.getAddress(), held, ctx.owner.address);
      expect(await ctx.stock.balanceOf(ctx.owner.address)).to.equal(held);
    });

    it("refuses to take a position out into the governor itself", async () => {
      const ctx = await deploy();
      await expect(ctx.governor.connect(ctx.owner).withdraw(await ctx.usdg.getAddress(), 1n, await ctx.governor.getAddress()))
        .to.be.revertedWithCustomError(ctx.governor, "InvalidRecipient");
    });

    it("will not let the operator take anything out", async () => {
      const ctx = await deploy();
      await expect(ctx.governor.connect(ctx.operator).withdraw(await ctx.usdg.getAddress(), 1n, ctx.operator.address))
        .to.be.revertedWithCustomError(ctx.governor, "NotOwner");
    });

    it("refuses to take out more than the governor holds", async () => {
      const ctx = await deploy();
      await expect(ctx.governor.connect(ctx.owner).withdraw(await ctx.usdg.getAddress(), 51n * USD, ctx.owner.address)).to.be.reverted;
    });
  });

  describe("the owner's limit price", () => {
    it("refuses a hijacked agent's trade: its own floor is met, the owner's price is not", async () => {
      const ctx = await deploy();
      // The attacker's pool: 1 USDG buys a hundred-millionth of a share.
      await ctx.venue.setPrice(100_000_000n * USD);
      const received = (1n * USD * SHARE) / (100_000_000n * USD);
      await expect(trade(ctx, { amountIn: 1n * USD, minOut: 1n }))
        .to.be.revertedWithCustomError(ctx.governor, "PriceAboveLimit")
        .withArgs(1n * USD, received, LIMIT);
      expect(await ctx.usdg.balanceOf(await ctx.governor.getAddress())).to.equal(50n * USD);
    });

    it("settles a fill a cent under the limit and refuses one a cent over, measured on what arrived", async () => {
      const ctx = await deploy();
      const CENT = USD / 100n;
      await ctx.venue.setPrice(LIMIT - CENT);
      await trade(ctx);
      await ctx.venue.setPrice(LIMIT + CENT);
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "PriceAboveLimit");
    });

    it("counts rounding against the venue: a fill quoted at exactly the limit that rounds shares down is over it", async () => {
      const ctx = await deploy();
      await ctx.venue.setPrice(LIMIT);
      // 5 USDG / $370 is 0.013513513513513513|51... shares; the venue keeps the remainder.
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "PriceAboveLimit")
        .withArgs(5n * USD, (5n * USD * SHARE) / LIMIT, LIMIT);
    });

    it("is the owner's alone, and zero removes it", async () => {
      const ctx = await deploy();
      const token = await ctx.stock.getAddress();
      await expect(ctx.governor.connect(ctx.operator).setPriceLimit(token, 0)).to.be.revertedWithCustomError(ctx.governor, "NotOwner");
      await ctx.venue.setPrice(1_000n * USD);
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "PriceAboveLimit");
      await expect(ctx.governor.connect(ctx.owner).setPriceLimit(token, 0)).to.emit(ctx.governor, "PriceLimitSet").withArgs(token, 0);
      await trade(ctx);
    });

    it("needs an approved token, and goes with the approval when it is revoked", async () => {
      const ctx = await deploy();
      const token = await ctx.stock.getAddress();
      await expect(ctx.governor.connect(ctx.owner).setPriceLimit(await ctx.other.getAddress(), LIMIT))
        .to.be.revertedWithCustomError(ctx.governor, "InstrumentNotAllowed");
      await ctx.governor.connect(ctx.owner).setInstrument(token, false, 0);
      await ctx.governor.connect(ctx.owner).setInstrument(token, true, 0);
      expect((await ctx.governor.instruments(token)).maxPrice).to.equal(0);
    });
  });

  describe("the Chainlink price guard", () => {
    const FEED = (usd: number) => BigInt(Math.round(usd * 1e8)); // 8-decimal USD answer

    async function guarded(oracleUsd: number, bps = 100, staleness = DAY) {
      const ctx = await deploy();
      const feed = await (await ethers.getContractFactory("MockAggregator")).deploy(8);
      await feed.set(FEED(oracleUsd), await time.latest());
      await ctx.governor.connect(ctx.owner).setPriceGuard(await ctx.stock.getAddress(), await feed.getAddress(), bps, staleness);
      return { ...ctx, feed };
    }

    it("settles a fill within the owner's margin over the oracle", async () => {
      const ctx = await guarded(334.0, 100); // venue fills at $334.49, 0.15% over
      await trade(ctx);
    });

    it("refuses a fill too far over the oracle, even one under the owner's limit price", async () => {
      const ctx = await guarded(300.0, 100); // the limit is $370; the market is $300
      const received = sharesFor(5n * USD);
      await expect(trade(ctx))
        .to.be.revertedWithCustomError(ctx.governor, "FillAboveOracle")
        .withArgs((5n * USD * SHARE) / received, 300n * USD, 100);
    });

    it("fails closed on a stale price: no fresh price, no trade", async () => {
      const ctx = await guarded(334.0, 100, DAY);
      const updatedAt = (await time.latest()) - 2 * DAY;
      await ctx.feed.set(FEED(334.0), updatedAt);
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "OracleStale").withArgs(updatedAt, DAY);
    });

    it("fails closed on a price that is zero or negative", async () => {
      const ctx = await guarded(334.0);
      await ctx.feed.set(0, await time.latest());
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "OracleInvalid").withArgs(0);
    });

    it("is the owner's alone, needs an approved token, and a zero feed removes it", async () => {
      const ctx = await guarded(300.0);
      const token = await ctx.stock.getAddress();
      const feed = await ctx.feed.getAddress();
      await expect(ctx.governor.connect(ctx.operator).setPriceGuard(token, ethers.ZeroAddress, 0, 0))
        .to.be.revertedWithCustomError(ctx.governor, "NotOwner");
      await expect(ctx.governor.connect(ctx.owner).setPriceGuard(await ctx.other.getAddress(), feed, 100, DAY))
        .to.be.revertedWithCustomError(ctx.governor, "InstrumentNotAllowed");
      await expect(trade(ctx)).to.be.revertedWithCustomError(ctx.governor, "FillAboveOracle");
      await ctx.governor.connect(ctx.owner).setPriceGuard(token, ethers.ZeroAddress, 0, 0);
      await trade(ctx);
    });

    it("refuses a feed with no code, a margin over 50%, or no staleness bound", async () => {
      const ctx = await guarded(334.0);
      const g = ctx.governor.connect(ctx.owner);
      const token = await ctx.stock.getAddress();
      const feed = await ctx.feed.getAddress();
      await expect(g.setPriceGuard(token, ctx.outsider.address, 100, DAY)).to.be.revertedWithCustomError(ctx.governor, "InvalidPriceGuard");
      await expect(g.setPriceGuard(token, feed, 5_001, DAY)).to.be.revertedWithCustomError(ctx.governor, "InvalidPriceGuard");
      await expect(g.setPriceGuard(token, feed, 100, 0)).to.be.revertedWithCustomError(ctx.governor, "InvalidPriceGuard");
    });

    it("goes with the approval when the token is revoked", async () => {
      const ctx = await guarded(300.0);
      const token = await ctx.stock.getAddress();
      await ctx.governor.connect(ctx.owner).setInstrument(token, false, 0);
      await ctx.governor.connect(ctx.owner).setInstrument(token, true, LIMIT);
      expect((await ctx.governor.priceGuards(token)).feed).to.equal(ethers.ZeroAddress);
      await trade(ctx);
    });
  });

  describe("the factory", () => {
    it("opens a governor, its lists, its limit prices and its deposit in one signature", async () => {
      const ctx = await deploy();
      const gov = await ctx.governor.getAddress();
      expect(await ctx.factory.governorsOf(ctx.owner.address)).to.deep.equal([gov]);
      expect(await ctx.governor.owner()).to.equal(ctx.owner.address);
      expect(await ctx.governor.operator()).to.equal(ctx.operator.address);
      expect(await ctx.governor.venueAllowed(await ctx.venue.getAddress())).to.equal(true);
      const inst = await ctx.governor.instruments(await ctx.stock.getAddress());
      expect([inst.allowed, inst.decimals, inst.maxPrice]).to.deep.equal([true, 18n, LIMIT]);
      expect(await ctx.usdg.balanceOf(gov)).to.equal(50n * USD);
    });

    it("cannot be initialised twice, and its implementation never at all", async () => {
      const ctx = await deploy();
      await expect(ctx.governor.initialize(ctx.outsider.address, ctx.outsider.address, await ctx.usdg.getAddress(), DAY, 1, 1))
        .to.be.revertedWithCustomError(ctx.governor, "AlreadyInitialized");
      const impl = await ethers.getContractAt("QuaestorStockGovernor", await ctx.factory.implementation());
      await expect(impl.initialize(ctx.outsider.address, ctx.operator.address, await ctx.usdg.getAddress(), DAY, 1, 1))
        .to.be.revertedWithCustomError(impl, "AlreadyInitialized");
    });

    it("lets only the factory set up the first lists, once", async () => {
      const ctx = await deploy();
      await expect(ctx.governor.connect(ctx.outsider).setupFromFactory([], [], [await ctx.other.getAddress()], [0]))
        .to.be.revertedWithCustomError(ctx.governor, "NotOwner");
    });

    it("lists each governor under the agent key it was made for", async () => {
      const ctx = await deploy();
      expect(await ctx.factory.governorsForOperator(ctx.operator.address)).to.deep.equal([await ctx.governor.getAddress()]);
      expect(await ctx.factory.governorsForOperator(ctx.outsider.address)).to.deep.equal([]);
    });

    it("sends the agent's key its gas in the same signature, and keeps none itself", async () => {
      const ctx = await deploy();
      const fresh = ethers.Wallet.createRandom().address;
      const gas = ethers.parseEther("0.001");
      await expect(ctx.factory.connect(ctx.owner).createGovernor({
        operator: fresh, budgetToken: await ctx.usdg.getAddress(), epochLength: DAY, perTradeCap: 5n * USD, epochCap: 20n * USD,
        venues: [], labels: [], tokens: [], maxPrices: [], deposit: 0n,
      }, { value: gas })).to.emit(ctx.factory, "OperatorFunded");
      expect(await ethers.provider.getBalance(fresh)).to.equal(gas);
      expect(await ethers.provider.getBalance(await ctx.factory.getAddress())).to.equal(0);
    });

    it("refuses an agent key that is also the owner's", async () => {
      const ctx = await deploy();
      await expect(createGovernor(ctx.factory, ctx.owner, {
        operator: ctx.owner.address, budgetToken: await ctx.usdg.getAddress(), venues: [], tokens: [], deposit: 0n,
      })).to.be.revertedWithCustomError(ctx.governor, "InvalidPolicy");
    });
  });
});

function anyValue() {
  // chai matchers' anyValue, without importing a path that moved between versions
  return (_: unknown) => true;
}
