import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * The governor against venues that lie.
 *
 * The point of V2 is that a venue is allowed, never trusted: the contract does
 * not read the route, it measures what left the treasury and what reached the
 * owner. So these tests are mostly routes behaving badly on purpose.
 */
describe("QuaestorV2 — a venue is allowed, not trusted", () => {
  const ONE = 10n ** 18n;
  const EXECUTION = 2;

  async function deploy() {
    const [owner, operator, outsider] = await ethers.getSigners();
    const governor = await (await ethers.getContractFactory("QuaestorV2")).deploy();
    const token = await (await ethers.getContractFactory("MockToken")).deploy();
    // One token per wei, so amounts read the same on both sides.
    const venue = await (await ethers.getContractFactory("HonestVenue")).deploy(await token.getAddress(), 1n);

    await governor.connect(owner).registerAgent(operator.address, 86_400, "ipfs://agent", { value: 10n * ONE });
    await governor.connect(owner).setPolicy(1, EXECUTION, 5n * ONE, 2n * ONE);
    await governor.connect(owner).setVenue(1, await venue.getAddress(), true);
    await governor.connect(owner).setInstrument(1, await token.getAddress(), true);
    return { governor, token, venue, owner, operator, outsider };
  }

  const buyData = (to: string) => new ethers.Interface(["function buy(address to)"]).encodeFunctionData("buy", [to]);
  const meta = ethers.id("decision");

  it("settles an honest route and charges the budget for it", async () => {
    const { governor, token, venue, owner, operator } = await deploy();
    await governor.connect(operator).swap(1, await venue.getAddress(), buyData(owner.address), await token.getAddress(), ONE, ONE, meta);

    expect(await token.balanceOf(owner.address)).to.equal(ONE);
    expect(await governor.balanceOf(1)).to.equal(9n * ONE);
    expect(await governor.spentIn(1, EXECUTION, 0)).to.equal(ONE);
  });

  it("reverts a route that sends the tokens somewhere else", async () => {
    const { governor, token, owner, operator } = await deploy();
    const thief = await (await ethers.getContractFactory("ThievingVenue")).deploy(await token.getAddress());
    await governor.connect(owner).setVenue(1, await thief.getAddress(), true);

    // The calldata names the owner; the venue ignores it and keeps the tokens.
    await expect(
      governor.connect(operator).swap(1, await thief.getAddress(), buyData(owner.address), await token.getAddress(), ONE, ONE, meta),
    ).to.be.revertedWithCustomError(governor, "MinimumOutputNotMet").withArgs(0, ONE);
    // The whole transaction reverted, so the spend never happened.
    expect(await governor.balanceOf(1)).to.equal(10n * ONE);
    expect(await governor.spentIn(1, EXECUTION, 0)).to.equal(0);
  });

  it("reverts a route that takes the money and reports success", async () => {
    const { governor, token, owner, operator } = await deploy();
    const empty = await (await ethers.getContractFactory("EmptyVenue")).deploy();
    await governor.connect(owner).setVenue(1, await empty.getAddress(), true);
    await expect(
      governor.connect(operator).swap(1, await empty.getAddress(), buyData(owner.address), await token.getAddress(), ONE, ONE, meta),
    ).to.be.revertedWithCustomError(governor, "MinimumOutputNotMet");
  });

  it("reverts a route that delivers less than it promised", async () => {
    const { governor, token, venue, owner, operator } = await deploy();
    // The venue pays one per wei; the intent demanded twice that.
    await expect(
      governor.connect(operator).swap(1, await venue.getAddress(), buyData(owner.address), await token.getAddress(), ONE, 2n * ONE, meta),
    ).to.be.revertedWithCustomError(governor, "MinimumOutputNotMet").withArgs(ONE, 2n * ONE);
  });

  it("reverts a route that delivers a different token than the one bought", async () => {
    const { governor, token, owner, operator } = await deploy();
    const substitute = await (await ethers.getContractFactory("SubstituteVenue")).deploy();
    await governor.connect(owner).setVenue(1, await substitute.getAddress(), true);
    // It mints the owner a thousand of its own token. Measuring the token that
    // was actually asked for is what tells the two apart.
    await expect(
      governor.connect(operator).swap(1, await substitute.getAddress(), buyData(owner.address), await token.getAddress(), ONE, ONE, meta),
    ).to.be.revertedWithCustomError(governor, "MinimumOutputNotMet").withArgs(0, ONE);
  });

  it("charges a route for what it kept, not for what it was handed", async () => {
    const { governor, token, venue, owner, operator } = await deploy();
    const keep = ONE / 4n;
    const data = new ethers.Interface(["function buyWithChange(address to, uint256 keep)"])
      .encodeFunctionData("buyWithChange", [owner.address, keep]);
    await governor.connect(operator).swap(1, await venue.getAddress(), data, await token.getAddress(), ONE, keep, meta);

    expect(await token.balanceOf(owner.address)).to.equal(keep);
    // Authorised one, kept a quarter: the rest is back in the treasury and the
    // epoch's spend reads a quarter, not one.
    expect(await governor.balanceOf(1)).to.equal(10n * ONE - keep);
    expect(await governor.spentIn(1, EXECUTION, 0)).to.equal(keep);
  });

  it("refuses a venue the owner never allowed, before any money moves", async () => {
    const { governor, token, owner, operator } = await deploy();
    const other = await (await ethers.getContractFactory("HonestVenue")).deploy(await token.getAddress(), 1n);
    await expect(
      governor.connect(operator).swap(1, await other.getAddress(), buyData(owner.address), await token.getAddress(), ONE, ONE, meta),
    ).to.be.revertedWithCustomError(governor, "VenueNotAllowed");
    expect(await governor.balanceOf(1)).to.equal(10n * ONE);
  });

  it("refuses a token the owner never allowed", async () => {
    const { governor, venue, owner, operator } = await deploy();
    const other = await (await ethers.getContractFactory("MockToken")).deploy();
    await expect(
      governor.connect(operator).swap(1, await venue.getAddress(), buyData(owner.address), await other.getAddress(), ONE, ONE, meta),
    ).to.be.revertedWithCustomError(governor, "InstrumentNotAllowed");
  });

  it("lets the owner take a venue away again", async () => {
    const { governor, token, venue, owner, operator } = await deploy();
    await governor.connect(operator).swap(1, await venue.getAddress(), buyData(owner.address), await token.getAddress(), ONE, ONE, meta);
    await governor.connect(owner).setVenue(1, await venue.getAddress(), false);
    await expect(
      governor.connect(operator).swap(1, await venue.getAddress(), buyData(owner.address), await token.getAddress(), ONE, ONE, meta),
    ).to.be.revertedWithCustomError(governor, "VenueNotAllowed");
  });

  it("keeps the allowlists the owner's alone", async () => {
    const { governor, venue, operator, outsider } = await deploy();
    for (const signer of [operator, outsider]) {
      await expect(governor.connect(signer).setVenue(1, await venue.getAddress(), true)).to.be.revertedWithCustomError(governor, "NotOwner");
      await expect(governor.connect(signer).setInstrument(1, await venue.getAddress(), true)).to.be.revertedWithCustomError(governor, "NotOwner");
    }
  });

  it("still enforces the caps, and only the operator may trade", async () => {
    const { governor, token, venue, owner, operator, outsider } = await deploy();
    const address = await venue.getAddress();
    await expect(
      governor.connect(operator).swap(1, address, buyData(owner.address), await token.getAddress(), 3n * ONE, ONE, meta),
    ).to.be.revertedWithCustomError(governor, "PerCallCapExceeded");

    for (let i = 0; i < 2; i += 1) {
      await governor.connect(operator).swap(1, address, buyData(owner.address), await token.getAddress(), 2n * ONE, ONE, meta);
    }
    await expect(
      governor.connect(operator).swap(1, address, buyData(owner.address), await token.getAddress(), 2n * ONE, ONE, meta),
    ).to.be.revertedWithCustomError(governor, "EpochCapExceeded");

    await expect(
      governor.connect(outsider).swap(1, address, buyData(owner.address), await token.getAddress(), ONE, ONE, meta),
    ).to.be.revertedWithCustomError(governor, "NotOperator");
  });

  it("refuses to trade while the agent is suspended, whoever suspended it", async () => {
    const { governor, token, venue, owner, operator, outsider } = await deploy();
    await governor.connect(owner).setGuardian(1, outsider.address);
    await governor.connect(outsider).suspend(1);
    await expect(
      governor.connect(operator).swap(1, await venue.getAddress(), buyData(owner.address), await token.getAddress(), ONE, ONE, meta),
    ).to.be.revertedWithCustomError(governor, "AgentIsSuspended");
    await governor.connect(owner).resume(1);
    await governor.connect(operator).swap(1, await venue.getAddress(), buyData(owner.address), await token.getAddress(), ONE, ONE, meta);
  });

  it("stops a venue spending the treasury twice in one call", async () => {
    const { governor, token, owner, operator } = await deploy();
    const reentrant = await (await ethers.getContractFactory("ReentrantVenue")).deploy(await token.getAddress());
    const address = await reentrant.getAddress();
    await governor.connect(owner).setVenue(1, address, true);
    const inner = governor.interface.encodeFunctionData("swap", [1, address, buyData(owner.address), await token.getAddress(), ONE, ONE, meta]);
    await reentrant.arm(await governor.getAddress(), inner);

    await expect(
      governor.connect(operator).swap(1, address, buyData(owner.address), await token.getAddress(), ONE, ONE, meta),
    ).to.be.revertedWithCustomError(governor, "VenueCallFailed");
    expect(await governor.balanceOf(1)).to.equal(10n * ONE);
  });

  it("will not authorise a trade with no floor to measure against", async () => {
    const { governor, token, venue, owner, operator } = await deploy();
    await expect(
      governor.connect(operator).swap(1, await venue.getAddress(), buyData(owner.address), await token.getAddress(), ONE, 0, meta),
    ).to.be.revertedWithCustomError(governor, "ZeroAmount");
  });
});

describe("QuaestorV2 — ether with no owner", () => {
  it("refuses ether sent to it outside a trade, so none of it belongs to nobody", async () => {
    const [sender] = await ethers.getSigners();
    const governor = await (await ethers.getContractFactory("QuaestorV2")).deploy();
    await expect(sender.sendTransaction({ to: await governor.getAddress(), value: 10n ** 16n })).to.be.reverted;
    expect(await ethers.provider.getBalance(await governor.getAddress())).to.equal(0);
  });
});
