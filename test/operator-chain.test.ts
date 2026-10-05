import { expect } from "chai";
import { ethers } from "hardhat";
import { GovernorClient, KeySender, Refused } from "../operator/chain";

/**
 * The Operator's chain client against a real payout governor: it reads the limits, adds a payee,
 * opens and pays a deal, and a refused call comes back as the contract's own reason, decoded,
 * before anything is signed or paid for.
 */
describe("operator chain client", () => {
  const USDC = (n: number) => BigInt(Math.round(n * 1e6));

  async function setup() {
    const [owner, payee] = await ethers.getSigners();
    const operatorWallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await owner.sendTransaction({ to: operatorWallet.address, value: ethers.parseEther("1") });
    const token = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    await token.mint(owner.address, USDC(100));
    const factory = await (await ethers.getContractFactory("QuaestorPayouts")).deploy();
    await token.approve(await factory.getAddress(), USDC(100));
    const s = {
      operator: operatorWallet.address, token: await token.getAddress(), epochLength: 7 * 86_400, perDealCap: USDC(20), epochCap: USDC(50),
      newPayeeCap: USDC(10), newPayeesPerEpoch: 2, payees: [], payeeCaps: [], tokenMessenger: ethers.ZeroAddress, maxForwardFeeBps: 0, deposit: USDC(100),
    };
    const governor = await factory.createGovernor.staticCall(s);
    await factory.createGovernor(s);
    const client = new GovernorClient(governor, ethers.provider, new KeySender(operatorWallet));
    return { owner, payee, token, client, operatorWallet };
  }

  it("reads the owner's limits and what is free to commit", async () => {
    const { client } = await setup();
    const l = await client.limits();
    expect(l).to.include({ perDealCap: USDC(20), epochCap: USDC(50), newPayeeCap: USDC(10), newPayeesPerEpoch: 2, freeBalance: USDC(100), suspended: false, crossChain: false });
  });

  it("adds a payee, opens a deal and pays it", async () => {
    const { payee, token, client } = await setup();
    await client.addPayee(payee.address, ethers.id("why"));
    expect(await client.payee(payee.address)).to.include({ allowed: true, vetted: false });
    const dealId = ethers.id("deal-1");
    const expiresAt = (await ethers.provider.getBlock("latest"))!.timestamp + 86_400;
    await client.openDeal(dealId, payee.address, USDC(8), expiresAt, ethers.id("terms"), ethers.id("why-open"));
    expect((await client.deal(dealId)).state).to.equal("open");
    const tx = await client.release(dealId, USDC(8), ethers.id("proof"), ethers.id("why-pay"));
    expect(tx).to.match(/^0x[0-9a-f]{64}$/);
    expect(await token.balanceOf(payee.address)).to.equal(USDC(8));
    expect((await client.deal(dealId)).state).to.equal("closed");
  });

  it("returns a refusal as the governor's own reason, and sends nothing", async () => {
    const { payee, client, operatorWallet } = await setup();
    await client.addPayee(payee.address, ethers.id("why"));
    const dealId = ethers.id("deal-2");
    const expiresAt = (await ethers.provider.getBlock("latest"))!.timestamp + 86_400;
    await client.openDeal(dealId, payee.address, USDC(10), expiresAt, ethers.id("terms"), ethers.id("why"));
    await client.release(dealId, USDC(5), ethers.id("p1"), ethers.id("why"));
    const nonce = await ethers.provider.getTransactionCount(operatorWallet.address);
    let refused: Refused | null = null;
    try {
      await client.release(dealId, USDC(5), ethers.id("p1"), ethers.id("why"));
    } catch (err) {
      refused = err as Refused;
    }
    expect(refused).to.be.instanceOf(Refused);
    expect(refused!.code).to.equal("ProofAlreadyUsed");
    expect(await ethers.provider.getTransactionCount(operatorWallet.address)).to.equal(nonce);
  });
});
