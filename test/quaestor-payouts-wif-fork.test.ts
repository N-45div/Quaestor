import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * The payout governor that burns, against the real WIF on a fork of Robinhood Chain mainnet: a
 * creator is paid in WIF, and the factory's share of the payout comes out of WIF's own total supply
 * through WIF's own `burn`. The mock tokens prove the rules; only this proves WIF behaves as the
 * contract expects (it accepts the governor's `burn(0)` probe, and a burn lowers `totalSupply`).
 *
 * It runs with `FORK_ROBINHOOD=1` and skips itself otherwise:
 *
 *   FORK_ROBINHOOD=1 npx hardhat test test/quaestor-payouts-wif-fork.test.ts
 */
const RH = {
  // Read on-chain 29 Oct 2026: symbol() "WIF", name() "World is Flat", 18 decimals, a PonsV2 launcher token with burn().
  wif: "0x5173b8ea6923c2d40267890d45c46a3480954773",
  // Uniswap v4's PoolManager on Robinhood Chain, which holds the ETH/WIF pool's WIF: a holder to fund the owner from.
  wifHolder: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
};

const WIF = (n: number) => ethers.parseEther(String(n));
const DAY = 86_400;
const id = (s: string) => ethers.id(s);

const wif = (signer?: any) =>
  new ethers.Contract(RH.wif, [
    "function symbol() view returns (string)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
  ], signer ?? ethers.provider);

async function impersonate(addr: string) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.request({ method: "hardhat_setBalance", params: [addr, "0x56BC75E2D63100000"] });
  return ethers.getSigner(addr);
}

(process.env.FORK_ROBINHOOD ? describe : describe.skip)("QuaestorPayouts paying in real WIF on Robinhood Chain", function () {
  this.timeout(180_000);

  // A call at the fork block itself needs the chain's hardfork history, which Hardhat 2.29 does not apply to
  // Robinhood Chain: mine one local block first, so every read runs on a block this node made.
  before(async () => { await network.provider.send("hardhat_mine", ["0x1"]); });

  let snapshot: string;
  beforeEach(async () => { snapshot = await network.provider.send("evm_snapshot"); });
  afterEach(async () => { await network.provider.send("evm_revert", [snapshot]); });

  async function campaign(burnBps: number) {
    const [owner, operator, creator] = await ethers.getSigners();
    expect(await wif().symbol()).to.equal("WIF");
    await wif(await impersonate(RH.wifHolder)).transfer(owner.address, WIF(100_000));

    const factory = await (await ethers.getContractFactory("QuaestorPayouts")).deploy(burnBps);
    const setup = {
      operator: operator.address, token: RH.wif, epochLength: 7 * DAY,
      perDealCap: WIF(20_000), epochCap: WIF(50_000), newPayeeCap: WIF(10_000), newPayeesPerEpoch: 5,
      payees: [], payeeCaps: [], tokenMessenger: ethers.ZeroAddress, maxForwardFeeBps: 0, deposit: 0,
    };
    // Opened for the owner by someone else, funded with a plain WIF transfer: the way a business opens one in the chat.
    const address = await factory.connect(operator).createGovernorFor.staticCall(owner.address, setup);
    await factory.connect(operator).createGovernorFor(owner.address, setup);
    const gov = await ethers.getContractAt("QuaestorPayoutGovernor", address);
    await wif(owner).transfer(address, WIF(50_000));
    await gov.connect(operator).addPayee(creator.address, id("a proven handle, real past work"));
    return { owner, operator, creator, gov };
  }

  it("pays a creator in WIF and burns 1% of the payout out of WIF's total supply", async () => {
    const { operator, creator, gov } = await campaign(100);
    const soon = BigInt((await time.latest()) + 14 * DAY);
    await gov.connect(operator).openDeal(id("deal"), creator.address, WIF(5_000), soon, id("terms"), id("offer"));

    const supplyBefore = await wif().totalSupply();
    await expect(gov.connect(operator).release(id("deal"), WIF(5_000), id("https://x.com/creator/status/1"), id("paid: checked")))
      .to.emit(gov, "Burned").withArgs(id("deal"), WIF(50));
    expect(await wif().balanceOf(creator.address)).to.equal(WIF(4_950));
    expect(supplyBefore - (await wif().totalSupply())).to.equal(WIF(50));
    expect(await wif().balanceOf(await gov.getAddress())).to.equal(WIF(45_000));
  });

  it("burns on every payout, and the owner takes the rest back unburned", async () => {
    const { owner, operator, creator, gov } = await campaign(100);
    const soon = BigInt((await time.latest()) + 14 * DAY);
    await gov.connect(operator).openDeal(id("a"), creator.address, WIF(2_000), soon, id("t"), id("w"));
    await gov.connect(operator).openDeal(id("b"), creator.address, WIF(3_000), soon, id("t"), id("w"));
    const supply0 = await wif().totalSupply();
    await gov.connect(operator).release(id("a"), WIF(2_000), id("proof a"), id("w"));
    await gov.connect(operator).release(id("b"), WIF(1_000), id("proof b"), id("w")); // part of a deal
    expect(supply0 - (await wif().totalSupply())).to.equal(WIF(30));

    const supply1 = await wif().totalSupply();
    const ownerBefore = await wif().balanceOf(owner.address);
    await gov.connect(owner).withdraw(owner.address, WIF(10_000));
    expect((await wif().balanceOf(owner.address)) - ownerBefore).to.equal(WIF(10_000));
    expect(await wif().totalSupply()).to.equal(supply1);
  });
});
