/**
 * Deploy the Stock Token governor's factory (contracts/QuaestorStocks.sol) and
 * record it in deployments/stocks-<network>.json.
 *
 *   npx hardhat run scripts/deploy-stocks-evm.ts --network monadTestnet
 *
 * The factory deploys the governor implementation in its own constructor, so
 * this is one transaction. On Monad the gas limit itself is charged, so the
 * limit is the estimate plus a small margin rather than a round number.
 */
import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`${network.name} (${chainId}) deployer ${deployer.address}, ${ethers.formatEther(balance)} native`);

  const Factory = await ethers.getContractFactory("QuaestorStocks");
  const tx = await Factory.getDeployTransaction();
  const estimate = await ethers.provider.estimateGas({ ...tx, from: deployer.address });
  const factory = await Factory.deploy({ gasLimit: (estimate * 110n) / 100n });
  const receipt = await factory.deploymentTransaction()!.wait();
  const address = await factory.getAddress();
  const implementation = await factory.implementation();
  console.log(`factory ${address} (block ${receipt!.blockNumber}, gas ${receipt!.gasUsed} of ${(estimate * 110n) / 100n}), implementation ${implementation}`);

  const out = {
    network: network.name,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    tx: receipt!.hash,
    block: receipt!.blockNumber,
    contracts: { QuaestorStocks: address, QuaestorStockGovernorImplementation: implementation },
  };
  const file = path.join(process.cwd(), "deployments", `stocks-${network.name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`recorded in ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
