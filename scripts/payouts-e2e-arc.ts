/**
 * The payout governor end to end on Arc testnet, with real test USDC and Circle's real CCTP:
 * a governor is opened, a payee signs where they want to be paid (Base Sepolia), the operator
 * adds them, opens a deal, pays part of it on Arc and the rest on Base through CCTP and
 * Circle's Forwarding Service, and the script waits for the mint to land on Base.
 *
 *   npx hardhat run scripts/payouts-e2e-arc.ts --network arcTestnet
 *
 * The operator and payee keys are throwaway test keys kept in E2E_KEYS (a JSON file).
 */
import { ethers, network } from "hardhat";
import * as fs from "node:fs";

const USDC_ARC = "0x3600000000000000000000000000000000000000";
const TOKEN_MESSENGER_V2_ARC_TESTNET = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
const IRIS = "https://iris-api-sandbox.circle.com";
const BASE_DOMAIN = 6;
const ARC_DOMAIN = 26;
const u = (n: number) => BigInt(Math.round(n * 1e6));

async function main() {
  const [owner] = await ethers.getSigners();
  const factoryAddress = JSON.parse(fs.readFileSync(`deployments/payouts-${network.name}.json`, "utf8")).contracts.QuaestorPayouts;
  const keysFile = process.env.E2E_KEYS ?? "e2e-keys.json";
  const keys = fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, "utf8")) : { operator: ethers.Wallet.createRandom().privateKey, payee: ethers.Wallet.createRandom().privateKey };
  fs.writeFileSync(keysFile, JSON.stringify(keys));
  const operator = new ethers.Wallet(keys.operator, ethers.provider);
  const payee = new ethers.Wallet(keys.payee, ethers.provider);
  console.log(`owner ${owner.address}, operator ${operator.address}, payee ${payee.address}`);

  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", USDC_ARC);
  const factory = await ethers.getContractAt("QuaestorPayouts", factoryAddress);

  // 1. The owner opens a governor: 10 USDC, the operator gets 0.5 USDC of gas with it.
  await (await usdc.connect(owner).approve(factoryAddress, u(10))).wait();
  const setup = {
    operator: operator.address, token: USDC_ARC, epochLength: 7 * 86_400,
    perDealCap: u(5), epochCap: u(20), newPayeeCap: u(2), newPayeesPerEpoch: 3,
    payees: [], payeeCaps: [], tokenMessenger: TOKEN_MESSENGER_V2_ARC_TESTNET, maxForwardFeeBps: 500, deposit: u(10),
  };
  const gas = ethers.parseEther("0.5"); // native USDC, 18 decimals, for the operator's gas
  const governorAddress = await factory.connect(owner).createGovernor.staticCall(setup, { value: gas });
  const created = await (await factory.connect(owner).createGovernor(setup, { value: gas })).wait();
  console.log(`1. governor ${governorAddress} (tx ${created!.hash})`);
  const gov = await ethers.getContractAt("QuaestorPayoutGovernor", governorAddress);

  // 2. The payee signs their route: be paid on Base Sepolia, at their own address.
  const recipient = ethers.zeroPadValue(payee.address, 32);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const { chainId } = await ethers.provider.getNetwork();
  const sig = await payee.signTypedData(
    { name: "QuaestorPayouts", version: "1", chainId, verifyingContract: governorAddress },
    { Route: [{ name: "payee", type: "address" }, { name: "domain", type: "uint32" }, { name: "recipient", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    { payee: payee.address, domain: BASE_DOMAIN, recipient, nonce: 0n, deadline },
  );
  const routed = await (await gov.connect(operator).setRoute(payee.address, BASE_DOMAIN, recipient, deadline, sig)).wait();
  console.log(`2. route signed by the payee, submitted by the operator (tx ${routed!.hash})`);

  // 3. The operator adds the payee (a stranger: capped at 2 USDC) and opens a 2 USDC deal.
  const dealId = ethers.id(`e2e-deal-${Date.now()}`);
  await (await gov.connect(operator).addPayee(payee.address, ethers.id("why: e2e payee"))).wait();
  const opened = await (await gov.connect(operator).openDeal(dealId, payee.address, u(2), BigInt(Math.floor(Date.now() / 1000) + 86_400), ethers.id("terms: e2e"), ethers.id("why: e2e deal"))).wait();
  console.log(`3. deal opened, 2 USDC escrowed (tx ${opened!.hash}); free ${ethers.formatUnits(await gov.freeBalance(), 6)} USDC`);

  // 4. Half a dollar here, on Arc.
  const local = await (await gov.connect(operator).release(dealId, u(0.5), ethers.id(`proof-local-${dealId}`), ethers.id("why: milestone 1"))).wait();
  console.log(`4. 0.5 USDC paid on Arc (tx ${local!.hash}); payee holds ${ethers.formatUnits(await usdc.balanceOf(payee.address), 6)} USDC on Arc`);

  // 5. The rest on Base Sepolia: the fee quote from Circle, capped by the governor at 5%.
  const fees = (await (await fetch(`${IRIS}/v2/burn/USDC/fees/${ARC_DOMAIN}/${BASE_DOMAIN}?forward=true`)).json()) as { finalityThreshold: number; minimumFee: number; forwardFee: { high: number } }[];
  const standard = fees.find((f) => f.finalityThreshold === 2000)!;
  const maxFee = BigInt(standard.forwardFee.high) + (u(1.5) * BigInt(standard.minimumFee)) / 10_000n;
  const base = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC, 84532, { staticNetwork: true });
  const baseUsdc = new ethers.Contract(USDC_BASE_SEPOLIA, ["function balanceOf(address) view returns (uint256)"], base);
  const before = await baseUsdc.balanceOf(payee.address);
  const cross = await (await gov.connect(operator).releaseCrossChain(dealId, u(1.5), maxFee, ethers.id(`proof-base-${dealId}`), ethers.id("why: milestone 2, paid on Base"))).wait();
  console.log(`5. 1.5 USDC burned on Arc for Base Sepolia, max fee ${ethers.formatUnits(maxFee, 6)} (tx ${cross!.hash})`);

  // 6. Circle attests, and its Forwarding Service mints on Base: the payee sends nothing.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = (await (await fetch(`${IRIS}/v2/messages/${ARC_DOMAIN}?transactionHash=${cross!.hash}`)).json()) as { messages?: { status: string; forwardTxHash?: string; forwardState?: string }[] };
    const m = res.messages?.[0];
    if (m?.forwardTxHash) {
      const after = await baseUsdc.balanceOf(payee.address);
      console.log(`6. minted on Base Sepolia by Circle's forwarder (tx ${m.forwardTxHash}); payee received ${ethers.formatUnits(after - before, 6)} USDC there`);
      console.log(`   deal state ${(await gov.dealOf(dealId)).state} (3 = closed)`);
      return;
    }
    if (i % 6 === 0) console.log(`   waiting: attestation ${m?.status ?? "not yet"}, forwarding ${m?.forwardState ?? "-"}`);
  }
  console.log("6. no forward transaction within five minutes; check Iris for", cross!.hash);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
