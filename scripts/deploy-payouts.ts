/**
 * Deploy the QuaestorPayouts factory (and with it the payout governor implementation).
 *
 *   npx hardhat run scripts/deploy-payouts.ts --network arcTestnet
 *   PAYOUT_BURN_BPS=100 npx hardhat run scripts/deploy-payouts.ts --network robinhood   # every payout burns 1%
 *
 * PAYOUT_BURN_BPS is the share of every payout each governor from this factory burns, in basis points (at most
 * 1,000); it is fixed for the factory's life, and a governor that burns needs a budget token with burn().
 * It writes deployments/payouts-<network>.json.
 */
import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  console.log(`${network.name} (${chainId}) deployer ${deployer.address}, ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} native`);

  const burnBps = Number(process.env.PAYOUT_BURN_BPS ?? 0);
  if (!Number.isInteger(burnBps) || burnBps < 0 || burnBps > 1_000) throw new Error(`PAYOUT_BURN_BPS must be 0 to 1000, not ${process.env.PAYOUT_BURN_BPS}`);
  const Factory = await ethers.getContractFactory("QuaestorPayouts");
  const tx = await Factory.getDeployTransaction(burnBps);
  const estimate = await ethers.provider.estimateGas({ ...tx, from: deployer.address });
  const factory = await Factory.deploy(burnBps, { gasLimit: (estimate * 110n) / 100n });
  const receipt = await factory.deploymentTransaction()!.wait();
  const address = await factory.getAddress();
  const implementation = await factory.implementation();
  console.log(`QuaestorPayouts ${address} (block ${receipt!.blockNumber}, gas ${receipt!.gasUsed}), implementation ${implementation}, burns ${burnBps / 100}% of every payout`);

  const file = path.join(process.cwd(), "deployments", `payouts-${network.name}.json`);
  fs.writeFileSync(file, `${JSON.stringify({
    network: network.name,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    tx: receipt!.hash,
    block: receipt!.blockNumber,
    burnBps,
    contracts: { QuaestorPayouts: address, QuaestorPayoutGovernorImplementation: implementation },
  }, null, 2)}\n`);
  console.log(`recorded in ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
