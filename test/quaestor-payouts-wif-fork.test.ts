import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { GovernorClient, KeySender } from "../operator/chain";
import { OP_NETWORKS } from "../operator/networks";
import { UniswapV4EthPricer, poolSlots } from "../operator/price";

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

  // The Operator's own chain client, priced by WIF's real pool and Chainlink's real ETH / USD on the fork.
  function operatorClient(gov: { getAddress(): Promise<string> }, operator: any, address: string, clock: () => number) {
    const pricer = new UniswapV4EthPricer(OP_NETWORKS.robinhood.price!, ethers.provider, clock);
    return { pricer, client: new GovernorClient(address, ethers.provider, new KeySender(operator), 18, { pricer, symbol: "WIF" }) };
  }

  /** Multiply the pool's sqrtPriceX96 by `k` in place: what a big swap does to the price for a block. */
  async function pushPool(k: number) {
    const cfg = OP_NETWORKS.robinhood.price!;
    const slot = poolSlots(cfg.poolId).slot0;
    const word = BigInt(await ethers.provider.send("eth_getStorageAt", [cfg.poolManager, slot, "latest"]));
    const mask = (1n << 160n) - 1n;
    const sqrt = (word & mask) * BigInt(Math.round(k * 1000)) / 1000n;
    await network.provider.send("hardhat_setStorageAt", [cfg.poolManager, slot, ethers.toBeHex((word & ~mask) | sqrt, 32)]);
  }

  it("escrows a deal's dollars in WIF at the pool's price, and pays out of that escrow whatever the price does after", async () => {
    const { operator, creator, gov } = await campaign(100);
    let clock = Date.now();
    const { pricer, client } = operatorClient(gov, operator, await gov.getAddress(), () => clock);
    const reading = await pricer.read();
    expect(reading.usdPerToken).to.be.within(1e-6, 1); // WIF trades at a fraction of a cent
    expect(reading.ethUsd).to.be.within(500, 20_000);

    const total = 5_000_000n; // $5 for the deal
    await client.openDeal(id("priced"), creator.address, total, (await time.latest()) + 14 * DAY, id("terms"), id("offer"));
    const escrowed = (await client.deal(id("priced"))).amountUnits;
    expect(escrowed).to.equal(total * reading.unitsPerMicroUsd);

    // WIF doubles after the deal opened. The deal still pays its own escrow: $2 of $5 is two fifths of it.
    await pushPool(1 / Math.SQRT2);
    clock += 31 * 60_000;
    await client.release(id("priced"), 2_000_000n, id("proof 1"), id("milestone 1"), total);
    await client.release(id("priced"), 3_000_000n, id("proof 2"), id("milestone 2"), total);
    const first = (escrowed * 2_000_000n) / total, second = escrowed - first;
    expect(await wif().balanceOf(creator.address)).to.equal(first - first / 100n + second - second / 100n);
    expect((await client.deal(id("priced"))).state).to.equal("closed");
    const limits = await client.limits();
    expect(limits.burnBps).to.equal(100);
    expect(limits.committedUnits).to.equal(0n);
  });

  it("never escrows more WIF than the last half hour's price says when the pool is pushed down for a block", async () => {
    const { operator, gov } = await campaign(100);
    let clock = Date.now();
    const { pricer } = operatorClient(gov, operator, await gov.getAddress(), () => clock);
    const before = await pricer.read();
    for (let i = 0; i < 5; i++) { clock += 61_000; await pricer.read(); }

    // Someone dumps WIF into the pool: it looks four times cheaper, so a dollar would escrow four times the WIF.
    await pushPool(2);
    clock += 61_000;
    const pushed = await pricer.read();
    expect(Number(pushed.spotUnitsPerMicroUsd) / Number(before.unitsPerMicroUsd)).to.be.closeTo(4, 0.01);
    expect(pushed.unitsPerMicroUsd).to.equal(before.unitsPerMicroUsd); // the recent median, not the pushed spot
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
