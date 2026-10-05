import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

/**
 * The payout governor: an AI operator pays people from a business's USDC, and the contract
 * decides what it may do alone. Every payment needs a deal with escrow, a deal over the
 * operator's limits waits for the owner, strangers are capped until vetted, a proof pays once,
 * and the operator can never pay itself or take money out.
 */
describe("QuaestorPayouts — an AI operator's allowance to pay people", () => {
  const USDC = (n: number) => BigInt(Math.round(n * 1e6));
  const DAY = 86_400;
  const id = (s: string) => ethers.id(s);

  async function setup(opts: { feeToken?: boolean } = {}) {
    const [owner, operator, guardian, vetted, stranger, stranger2, stranger3, outsider] = await ethers.getSigners();
    const token = opts.feeToken
      ? await (await ethers.getContractFactory("FeeOnTransferToken")).deploy()
      : await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    await token.mint(owner.address, USDC(10_000));
    const factory = await (await ethers.getContractFactory("QuaestorPayouts")).deploy();
    const messenger = await (await ethers.getContractFactory("MockTokenMessengerV2")).deploy();
    await token.connect(owner).approve(await factory.getAddress(), USDC(1_000));
    const setupArgs = {
      operator: operator.address,
      token: await token.getAddress(),
      epochLength: 7 * DAY,
      perDealCap: USDC(200),
      epochCap: USDC(500),
      newPayeeCap: USDC(50),
      newPayeesPerEpoch: 2,
      payees: [vetted.address],
      payeeCaps: [USDC(300)],
      tokenMessenger: await messenger.getAddress(),
      maxForwardFeeBps: 300, // CCTP's fees may take at most 3% of a payout
      deposit: USDC(1_000),
    };
    const address = await factory.connect(owner).createGovernor.staticCall(setupArgs, { value: ethers.parseEther("0.01") });
    await factory.connect(owner).createGovernor(setupArgs, { value: ethers.parseEther("0.01") });
    const gov = await ethers.getContractAt("QuaestorPayoutGovernor", address);
    const asOperator = gov.connect(operator);
    const soon = async (days = 14) => BigInt((await time.latest()) + days * DAY);
    return { owner, operator, guardian, vetted, stranger, stranger2, stranger3, outsider, token, factory, messenger, gov, asOperator, soon };
  }

  /** A payee's signed choice of where to be paid: a CCTP domain and the recipient there. */
  async function signRoute(gov: Awaited<ReturnType<typeof setup>>["gov"], signer: Awaited<ReturnType<typeof setup>>["owner"], payee: string, domain: number, recipient: string, deadline: bigint) {
    const { chainId } = await ethers.provider.getNetwork();
    const nonce = await gov.routeNonces(payee);
    return signer.signTypedData(
      { name: "QuaestorPayouts", version: "1", chainId, verifyingContract: await gov.getAddress() },
      { Route: [{ name: "payee", type: "address" }, { name: "domain", type: "uint32" }, { name: "recipient", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      { payee, domain, recipient, nonce, deadline },
    );
  }
  const BASE_DOMAIN = 6;
  const asBytes32 = (address: string) => ethers.zeroPadValue(address, 32);

  describe("setting up", () => {
    it("creates a governor with the owner's limits, deposit, vetted payees, and gas for the operator", async () => {
      const { owner, operator, vetted, token, factory, gov } = await setup();
      expect(await gov.owner()).to.equal(owner.address);
      expect(await gov.operator()).to.equal(operator.address);
      expect(await gov.tokenDecimals()).to.equal(6);
      expect(await gov.perDealCap()).to.equal(USDC(200));
      expect(await token.balanceOf(await gov.getAddress())).to.equal(USDC(1_000));
      const p = await gov.payeeOf(vetted.address);
      expect([p.allowed, p.vetted, p.cap]).to.deep.equal([true, true, USDC(300)]);
      expect(await factory.governorsOf(owner.address)).to.deep.equal([await gov.getAddress()]);
      expect(await factory.governorsForOperator(operator.address)).to.deep.equal([await gov.getAddress()]);
    });

    it("cannot be initialised again, and the implementation never can be", async () => {
      const { owner, operator, token, factory, gov } = await setup();
      const args = [owner.address, operator.address, await token.getAddress(), 7 * DAY, USDC(1), USDC(1), USDC(1), 1] as const;
      await expect(gov.initialize(...args)).to.be.revertedWithCustomError(gov, "AlreadyInitialized");
      const impl = await ethers.getContractAt("QuaestorPayoutGovernor", await factory.implementation());
      await expect(impl.initialize(...args)).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
      await expect(gov.setupFromFactory([], [], ethers.ZeroAddress, 0)).to.be.revertedWithCustomError(gov, "NotOwner");
    });

    it("refuses limits that do not nest: new-payee cap ≤ per-deal cap ≤ period cap", async () => {
      const { owner, gov } = await setup();
      await expect(gov.connect(owner).setLimits(USDC(600), USDC(500), USDC(50), 2, 7 * DAY)).to.be.revertedWithCustomError(gov, "InvalidPolicy");
      await expect(gov.connect(owner).setLimits(USDC(100), USDC(500), USDC(150), 2, 7 * DAY)).to.be.revertedWithCustomError(gov, "InvalidPolicy");
      await expect(gov.connect(owner).setLimits(USDC(100), USDC(500), USDC(50), 2, 0)).to.be.revertedWithCustomError(gov, "InvalidPolicy");
    });
  });

  describe("deals and releases", () => {
    it("escrows a deal inside the limits and pays exactly the release against a proof", async () => {
      const { vetted, token, gov, asOperator, soon } = await setup();
      const deadline = await soon();
      await expect(asOperator.openDeal(id("d1"), vetted.address, USDC(150), deadline, id("terms"), id("why-open")))
        .to.emit(gov, "DealOpened").withArgs(id("d1"), vetted.address, USDC(150), deadline, id("terms"), false, id("why-open"));
      expect(await gov.committed()).to.equal(USDC(150));
      expect(await gov.freeBalance()).to.equal(USDC(850));

      await expect(asOperator.release(id("d1"), USDC(100), id("proof-1"), id("why-pay")))
        .to.emit(gov, "Released").withArgs(id("d1"), vetted.address, USDC(100), id("proof-1"), id("why-pay"), anyValue, USDC(100));
      expect(await gov.currentEpoch()).to.equal(BigInt(Math.floor((await time.latest()) / (7 * DAY))));
      expect(await token.balanceOf(vetted.address)).to.equal(USDC(100));
      expect(await gov.committed()).to.equal(USDC(50));
      await asOperator.release(id("d1"), USDC(50), id("proof-2"), id("why-pay-2"));
      expect((await gov.dealOf(id("d1"))).state).to.equal(3n); // Closed
      expect(await gov.committed()).to.equal(0n);
    });

    it("pays a proof once, ever, across deals", async () => {
      const { vetted, gov, asOperator, soon } = await setup();
      await asOperator.openDeal(id("a"), vetted.address, USDC(20), await soon(), id("t"), id("w"));
      await asOperator.openDeal(id("b"), vetted.address, USDC(20), await soon(), id("t"), id("w"));
      await asOperator.release(id("a"), USDC(10), id("same-post"), id("w"));
      await expect(asOperator.release(id("b"), USDC(10), id("same-post"), id("w"))).to.be.revertedWithCustomError(gov, "ProofAlreadyUsed");
      await expect(asOperator.release(id("b"), USDC(10), ethers.ZeroHash, id("w"))).to.be.revertedWithCustomError(gov, "MissingProof");
    });

    it("never releases more than the deal, and refuses a deal id twice", async () => {
      const { vetted, gov, asOperator, soon } = await setup();
      await asOperator.openDeal(id("d"), vetted.address, USDC(30), await soon(), id("t"), id("w"));
      await expect(asOperator.release(id("d"), USDC(31), id("p"), id("w"))).to.be.revertedWithCustomError(gov, "OverDeal");
      await expect(asOperator.openDeal(id("d"), vetted.address, USDC(1), await soon(), id("t"), id("w"))).to.be.revertedWithCustomError(gov, "DealExists");
    });

    it("cannot commit money another deal has set aside", async () => {
      const { owner, vetted, gov, asOperator, soon } = await setup();
      await gov.connect(owner).setLimits(USDC(900), USDC(5_000), USDC(50), 2, 7 * DAY);
      await asOperator.openDeal(id("big"), vetted.address, USDC(900), await soon(), id("t"), id("w"));
      await expect(asOperator.openDeal(id("more"), vetted.address, USDC(150), await soon(), id("t"), id("w")))
        .to.be.revertedWithCustomError(gov, "InsufficientFreeBalance").withArgs(USDC(150), USDC(100));
    });

    it("refuses a deadline in the past or more than 90 days out, and a zero amount", async () => {
      const { vetted, gov, asOperator, soon } = await setup();
      const now = BigInt(await time.latest());
      await expect(asOperator.openDeal(id("d"), vetted.address, USDC(10), now, id("t"), id("w"))).to.be.revertedWithCustomError(gov, "InvalidDeadline");
      await expect(asOperator.openDeal(id("d"), vetted.address, USDC(10), await soon(91), id("t"), id("w"))).to.be.revertedWithCustomError(gov, "InvalidDeadline");
      await expect(asOperator.openDeal(id("d"), vetted.address, 0, await soon(), id("t"), id("w"))).to.be.revertedWithCustomError(gov, "InvalidAmount");
    });
  });

  describe("what the operator cannot do alone", () => {
    it("parks a deal over the per-deal cap until the owner approves it; then the caps are the owner's call", async () => {
      const { owner, vetted, token, gov, asOperator, soon } = await setup();
      await expect(asOperator.openDeal(id("big"), vetted.address, USDC(600), await soon(), id("t"), id("w")))
        .to.emit(gov, "DealOpened");
      expect((await gov.dealOf(id("big"))).state).to.equal(1n); // Pending
      expect(await gov.committed()).to.equal(0n);
      await expect(asOperator.release(id("big"), USDC(600), id("p"), id("w"))).to.be.revertedWithCustomError(gov, "DealNotOpen");
      await expect(gov.connect(vetted).approveDeal(id("big"))).to.be.revertedWithCustomError(gov, "NotOwner");

      await gov.connect(owner).approveDeal(id("big"));
      expect(await gov.committed()).to.equal(USDC(600));
      // Over the 500 period cap and the payee's 300 cap: the owner approved this amount.
      await asOperator.release(id("big"), USDC(600), id("p"), id("w"));
      expect(await token.balanceOf(vetted.address)).to.equal(USDC(600));
      expect(await gov.paidInEpoch()).to.equal(0n);
    });

    it("keeps its own releases inside the period cap, and starts again next period", async () => {
      const { owner, vetted, stranger, gov, asOperator, soon } = await setup();
      await gov.connect(owner).setPayee(stranger.address, true, true, 0);
      await asOperator.openDeal(id("a"), vetted.address, USDC(200), await soon(), id("t"), id("w"));
      await asOperator.openDeal(id("b"), stranger.address, USDC(200), await soon(), id("t"), id("w"));
      await asOperator.openDeal(id("c"), stranger.address, USDC(200), await soon(), id("t"), id("w"));
      await asOperator.release(id("a"), USDC(200), id("p1"), id("w"));
      await asOperator.release(id("b"), USDC(200), id("p2"), id("w"));
      await expect(asOperator.release(id("c"), USDC(200), id("p3"), id("w")))
        .to.be.revertedWithCustomError(gov, "EpochCapExceeded").withArgs(USDC(600), USDC(500));
      await time.increase(7 * DAY);
      await asOperator.release(id("c"), USDC(200), id("p3"), id("w"));
    });

    it("caps a vetted payee per period", async () => {
      const { vetted, gov, asOperator, soon } = await setup();
      await asOperator.openDeal(id("a"), vetted.address, USDC(200), await soon(), id("t"), id("w"));
      await asOperator.openDeal(id("b"), vetted.address, USDC(200), await soon(), id("t"), id("w"));
      await asOperator.release(id("a"), USDC(200), id("p1"), id("w"));
      await expect(asOperator.release(id("b"), USDC(150), id("p2"), id("w")))
        .to.be.revertedWithCustomError(gov, "PayeeCapExceeded").withArgs(vetted.address, USDC(350), USDC(300));
    });

    it("lets the operator add a few strangers per period, each capped until the owner vets them", async () => {
      const { owner, stranger, stranger2, stranger3, gov, asOperator, soon } = await setup();
      await asOperator.addPayee(stranger.address, id("why-them"));
      await asOperator.addPayee(stranger2.address, id("why-them-2"));
      await expect(asOperator.addPayee(stranger3.address, id("why"))).to.be.revertedWithCustomError(gov, "NewPayeeLimitReached");
      const p = await gov.payeeOf(stranger.address);
      expect([p.allowed, p.vetted]).to.deep.equal([true, false]);

      // A stranger's deal over the new-payee cap waits for the owner; under it, opens.
      await asOperator.openDeal(id("over"), stranger.address, USDC(60), await soon(), id("t"), id("w"));
      expect((await gov.dealOf(id("over"))).state).to.equal(1n);
      await asOperator.openDeal(id("a"), stranger.address, USDC(40), await soon(), id("t"), id("w"));
      await asOperator.openDeal(id("b"), stranger.address, USDC(40), await soon(), id("t"), id("w"));
      await asOperator.release(id("a"), USDC(40), id("p1"), id("w"));
      await expect(asOperator.release(id("b"), USDC(40), id("p2"), id("w")))
        .to.be.revertedWithCustomError(gov, "PayeeCapExceeded").withArgs(stranger.address, USDC(80), USDC(50));

      // Vetted by the owner, the stranger's own cap applies.
      await gov.connect(owner).setPayee(stranger.address, true, true, USDC(250));
      await asOperator.release(id("b"), USDC(40), id("p2"), id("w"));
      await time.increase(7 * DAY);
      await asOperator.addPayee(stranger3.address, id("why"));
    });

    it("can never pay itself or the governor", async () => {
      const { owner, operator, gov, asOperator } = await setup();
      await expect(asOperator.addPayee(operator.address, id("w"))).to.be.revertedWithCustomError(gov, "InvalidPayee");
      await expect(asOperator.addPayee(await gov.getAddress(), id("w"))).to.be.revertedWithCustomError(gov, "InvalidPayee");
      await expect(gov.connect(owner).setPayee(operator.address, true, true, 0)).to.be.revertedWithCustomError(gov, "InvalidPayee");
    });

    it("cannot bring back a payee the owner removed, or pay one on an open deal", async () => {
      const { owner, vetted, gov, asOperator, soon } = await setup();
      await asOperator.openDeal(id("d"), vetted.address, USDC(50), await soon(), id("t"), id("w"));
      await gov.connect(owner).setPayee(vetted.address, false, false, 0);
      await expect(asOperator.addPayee(vetted.address, id("w"))).to.be.revertedWithCustomError(gov, "PayeeBlocked");
      await expect(asOperator.release(id("d"), USDC(50), id("p"), id("w"))).to.be.revertedWithCustomError(gov, "PayeeNotAllowed");
      await expect(asOperator.openDeal(id("e"), vetted.address, USDC(5), await soon(), id("t"), id("w"))).to.be.revertedWithCustomError(gov, "PayeeNotAllowed");
      await gov.connect(owner).setPayee(vetted.address, true, true, USDC(300));
      await asOperator.release(id("d"), USDC(50), id("p"), id("w"));
    });

    it("cannot withdraw, change limits or vet anyone; only the owner can", async () => {
      const { stranger, gov, asOperator } = await setup();
      await expect(asOperator.withdraw(stranger.address, 1)).to.be.revertedWithCustomError(gov, "NotOwner");
      await expect(asOperator.setLimits(USDC(1), USDC(1), USDC(1), 1, DAY)).to.be.revertedWithCustomError(gov, "NotOwner");
      await expect(asOperator.setPayee(stranger.address, true, true, 0)).to.be.revertedWithCustomError(gov, "NotOwner");
      await expect(gov.connect(stranger).release(ethers.ZeroHash, 1, id("p"), id("w"))).to.be.revertedWithCustomError(gov, "NotOperator");
    });
  });

  describe("money out, deadlines and stopping", () => {
    it("lets the owner withdraw only what no deal has set aside", async () => {
      const { owner, vetted, token, gov, asOperator, soon } = await setup();
      await asOperator.openDeal(id("d"), vetted.address, USDC(150), await soon(), id("t"), id("w"));
      await expect(gov.connect(owner).withdraw(owner.address, USDC(900)))
        .to.be.revertedWithCustomError(gov, "InsufficientFreeBalance").withArgs(USDC(900), USDC(850));
      await gov.connect(owner).withdraw(owner.address, USDC(850));
      await gov.connect(owner).cancelDeal(id("d"), id("changed my mind"));
      await gov.connect(owner).withdraw(owner.address, USDC(150));
      expect(await token.balanceOf(await gov.getAddress())).to.equal(0n);
    });

    it("lets a deal lapse at its deadline, and anyone free its escrow then", async () => {
      const { vetted, outsider, gov, asOperator, soon } = await setup();
      await asOperator.openDeal(id("d"), vetted.address, USDC(80), await soon(3), id("t"), id("w"));
      await expect(gov.connect(outsider).expire(id("d"))).to.be.revertedWithCustomError(gov, "DealNotExpired");
      await time.increase(3 * DAY);
      await expect(asOperator.release(id("d"), USDC(80), id("p"), id("w"))).to.be.revertedWithCustomError(gov, "DealExpired");
      await gov.connect(outsider).expire(id("d"));
      expect(await gov.committed()).to.equal(0n);
      expect((await gov.dealOf(id("d"))).state).to.equal(4n); // Cancelled
    });

    it("can be stopped by a guardian, and started again only by the owner", async () => {
      const { owner, guardian, vetted, gov, asOperator, soon } = await setup();
      await gov.connect(owner).setGuardian(guardian.address);
      await gov.connect(guardian).setSuspended(true);
      await expect(asOperator.openDeal(id("d"), vetted.address, USDC(1), await soon(), id("t"), id("w"))).to.be.revertedWithCustomError(gov, "Suspended");
      await expect(asOperator.addPayee(owner.address, id("w"))).to.be.revertedWithCustomError(gov, "Suspended");
      await expect(gov.connect(guardian).setSuspended(false)).to.be.revertedWithCustomError(gov, "NotOwner");
      await gov.connect(owner).setSuspended(false);
      await asOperator.openDeal(id("d"), vetted.address, USDC(1), await soon(), id("t"), id("w"));
    });

    it("cannot be pointed at a cross-chain messenger that has no code, or let fees take over a fifth", async () => {
      const { owner, outsider, gov } = await setup();
      await expect(gov.connect(owner).setCrossChain(outsider.address, 300)).to.be.revertedWithCustomError(gov, "InvalidPolicy");
      await expect(gov.connect(owner).setCrossChain(ethers.ZeroAddress, 2_001)).to.be.revertedWithCustomError(gov, "InvalidPolicy");
    });

    it("measures each release: a token that skims in transit is refused", async () => {
      const { vetted, gov, asOperator, soon } = await setup({ feeToken: true });
      await asOperator.openDeal(id("d"), vetted.address, USDC(100), await soon(), id("t"), id("w"));
      await expect(asOperator.release(id("d"), USDC(100), id("p"), id("w")))
        .to.be.revertedWithCustomError(gov, "TransferMismatch").withArgs(USDC(100), USDC(99), USDC(100));
    });
  });

  describe("paying on the payee's own chain (CCTP)", () => {
    it("burns exactly the payout to the route the payee signed, with Circle's forwarding hook", async () => {
      const { vetted, outsider, token, messenger, gov, asOperator, soon } = await setup();
      const recipient = asBytes32(vetted.address);
      const deadline = await soon(1);
      const sig = await signRoute(gov, vetted, vetted.address, BASE_DOMAIN, recipient, deadline);
      // Anyone may submit it: the signature is the payee's choice, not the submitter's.
      await expect(gov.connect(outsider).setRoute(vetted.address, BASE_DOMAIN, recipient, deadline, sig))
        .to.emit(gov, "RouteSet").withArgs(vetted.address, BASE_DOMAIN, recipient);

      await asOperator.openDeal(id("d"), vetted.address, USDC(100), await soon(), id("t"), id("w"));
      await expect(asOperator.releaseCrossChain(id("d"), USDC(100), USDC(0.06), id("post"), id("why")))
        .to.emit(gov, "ReleasedCrossChain").withArgs(id("d"), vetted.address, USDC(100), USDC(0.06), BASE_DOMAIN, recipient, id("post"), id("why"));
      const burn = await messenger.last();
      expect(burn.amount).to.equal(USDC(100));
      expect(burn.destinationDomain).to.equal(BASE_DOMAIN);
      expect(burn.mintRecipient).to.equal(recipient);
      expect(burn.burnToken).to.equal(await token.getAddress());
      expect(burn.destinationCaller).to.equal(ethers.ZeroHash);
      expect(burn.minFinalityThreshold).to.equal(2000);
      expect(burn.hookData).to.equal(await gov.FORWARD_HOOK());
      expect(ethers.toUtf8String(ethers.stripZerosLeft(ethers.dataSlice(burn.hookData, 0, 12)))).to.equal("cctp-forward");
      expect(await token.allowance(await gov.getAddress(), await messenger.getAddress())).to.equal(0n);
      expect((await gov.dealOf(id("d"))).state).to.equal(3n);
    });

    it("refuses a route the payee did not sign, a signature used twice, and one past its deadline", async () => {
      const { operator, vetted, gov, soon } = await setup();
      const evil = asBytes32(operator.address);
      const deadline = await soon(1);
      // The operator cannot choose where a payee is paid.
      const forged = await signRoute(gov, operator, vetted.address, BASE_DOMAIN, evil, deadline);
      await expect(gov.setRoute(vetted.address, BASE_DOMAIN, evil, deadline, forged)).to.be.revertedWithCustomError(gov, "BadSignature");

      const sig = await signRoute(gov, vetted, vetted.address, BASE_DOMAIN, asBytes32(vetted.address), deadline);
      await gov.setRoute(vetted.address, BASE_DOMAIN, asBytes32(vetted.address), deadline, sig);
      await expect(gov.setRoute(vetted.address, BASE_DOMAIN, asBytes32(vetted.address), deadline, sig)).to.be.revertedWithCustomError(gov, "BadSignature");

      const late = await signRoute(gov, vetted, vetted.address, 3, asBytes32(vetted.address), deadline);
      await time.increaseTo(deadline + 1n);
      await expect(gov.setRoute(vetted.address, 3, asBytes32(vetted.address), deadline, late)).to.be.revertedWithCustomError(gov, "SignatureExpired");
    });

    it("lets a payee set a route from their own address, voiding any signed one still unused", async () => {
      const { vetted, gov, soon } = await setup();
      const pending = await signRoute(gov, vetted, vetted.address, 3, asBytes32(vetted.address), await soon(1));
      await gov.connect(vetted).setMyRoute(BASE_DOMAIN, asBytes32(vetted.address));
      expect((await gov.routes(vetted.address)).domain).to.equal(BASE_DOMAIN);
      await expect(gov.setRoute(vetted.address, 3, asBytes32(vetted.address), await soon(1), pending)).to.be.revertedWithCustomError(gov, "BadSignature");
    });

    it("keeps fees inside the owner's cap, and needs a route and a messenger", async () => {
      const { owner, vetted, stranger, gov, asOperator, soon } = await setup();
      await gov.connect(vetted).setMyRoute(BASE_DOMAIN, asBytes32(vetted.address));
      await asOperator.openDeal(id("d"), vetted.address, USDC(100), await soon(), id("t"), id("w"));
      await expect(asOperator.releaseCrossChain(id("d"), USDC(100), USDC(3.01), id("p"), id("w")))
        .to.be.revertedWithCustomError(gov, "FeeTooHigh").withArgs(USDC(3.01), USDC(3));

      await gov.connect(owner).setPayee(stranger.address, true, true, 0);
      await asOperator.openDeal(id("e"), stranger.address, USDC(10), await soon(), id("t"), id("w"));
      await expect(asOperator.releaseCrossChain(id("e"), USDC(10), 0, id("p2"), id("w"))).to.be.revertedWithCustomError(gov, "NoRoute");

      await gov.connect(owner).setCrossChain(ethers.ZeroAddress, 0);
      await expect(asOperator.releaseCrossChain(id("d"), USDC(100), 0, id("p"), id("w"))).to.be.revertedWithCustomError(gov, "CrossChainDisabled");
    });

    it("shares proofs and caps with local releases", async () => {
      const { vetted, gov, asOperator, soon } = await setup();
      await gov.connect(vetted).setMyRoute(BASE_DOMAIN, asBytes32(vetted.address));
      await asOperator.openDeal(id("a"), vetted.address, USDC(200), await soon(), id("t"), id("w"));
      await asOperator.openDeal(id("b"), vetted.address, USDC(200), await soon(), id("t"), id("w"));
      await asOperator.releaseCrossChain(id("a"), USDC(200), 0, id("post"), id("w"));
      await expect(asOperator.release(id("b"), USDC(50), id("post"), id("w"))).to.be.revertedWithCustomError(gov, "ProofAlreadyUsed");
      await expect(asOperator.releaseCrossChain(id("b"), USDC(150), 0, id("post-2"), id("w")))
        .to.be.revertedWithCustomError(gov, "PayeeCapExceeded").withArgs(vetted.address, USDC(350), USDC(300));
    });

    it("refuses a messenger that does not take exactly what it was lent", async () => {
      const { vetted, messenger, gov, asOperator, soon } = await setup();
      await gov.connect(vetted).setMyRoute(BASE_DOMAIN, asBytes32(vetted.address));
      await asOperator.openDeal(id("d"), vetted.address, USDC(100), await soon(), id("t"), id("w"));
      await messenger.setShort(true);
      await expect(asOperator.releaseCrossChain(id("d"), USDC(100), 0, id("p"), id("w"))).to.be.revertedWithCustomError(gov, "AllowanceLeftBehind").withArgs(1);
    });
  });
});
