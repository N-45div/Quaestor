/**
 * Put QuaestorLog on a chain, and record where and from which block.
 *
 *   npx hardhat run scripts/deploy-log.ts --network base
 *
 * It has no owner and no constructor arguments, so there is nothing to set up
 * after it lands. The block is read from the deployment's own receipt, because
 * a follow-up read against a public endpoint can answer from an earlier block,
 * and a subgraph that starts one block late never sees the first record.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

async function main() {
  const statePath = join(__dirname, "..", "deployments", `${network.name}.json`);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const existing = state.contracts?.QuaestorLog;
  if (existing && (await ethers.provider.getCode(existing)) !== "0x") {
    console.log(`QuaestorLog already at ${existing}, from block ${state.log?.deployBlock}`);
    return;
  }

  const factory = await ethers.getContractFactory("QuaestorLog");
  const contract = await factory.deploy();
  const receipt = await contract.deploymentTransaction()!.wait();
  const address = await contract.getAddress();

  state.contracts = { ...state.contracts, QuaestorLog: address };
  state.log = { deployBlock: receipt!.blockNumber, deployTx: receipt!.hash };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  // The fee from the receipt itself, with the L1 data fee an OP-stack chain
  // adds, which ethers does not surface. A balance read before and after comes
  // back from a lagging endpoint as no cost at all.
  const raw = await ethers.provider.send("eth_getTransactionReceipt", [receipt!.hash]);
  const fee = BigInt(raw.gasUsed) * BigInt(raw.effectiveGasPrice) + BigInt(raw.l1Fee ?? 0);
  state.log.feeWei = fee.toString();
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`QuaestorLog ${address}, block ${receipt!.blockNumber}, tx ${receipt!.hash}`);
  console.log(`cost ${ethers.formatEther(fee)} ETH, L1 data fee included`);
}

main().catch((error) => {
  console.error(String((error as Error).message ?? error));
  process.exitCode = 1;
});
