import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Ops helper: appoint a guardian for an agent (owner key = deployer).
 * Env: AGENT_ID (default 1), GUARDIAN_ADDRESS (required).
 */
async function main() {
  const guardian = process.env.GUARDIAN_ADDRESS;
  if (!guardian) throw new Error("Set GUARDIAN_ADDRESS");
  const agentId = BigInt(process.env.AGENT_ID ?? "1");

  const file = path.join(
    __dirname,
    "..",
    "deployments",
    `${network.name === "localhost" ? "local" : network.name}.json`
  );
  const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  const quaestor = await ethers.getContractAt("Quaestor", deployment.contracts.Quaestor);

  const tx = await quaestor.setGuardian(agentId, guardian);
  await tx.wait();
  console.log(`Guardian for agent #${agentId} set to ${guardian} (${tx.hash})`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
