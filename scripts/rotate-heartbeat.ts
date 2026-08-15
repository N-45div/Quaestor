import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * One-time ops: retire the old "Proba (public demo)" agent and register
 * "Pulse — governed heartbeat" in its place, reusing the same operator key
 * and recycling the old treasury so no faucet OKB is wasted.
 */
async function main() {
  const file = path.join(
    __dirname,
    "..",
    "deployments",
    `${network.name === "localhost" ? "local" : network.name}.json`
  );
  const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  const quaestor = await ethers.getContractAt("Quaestor", deployment.contracts.Quaestor);
  const [owner] = await ethers.getSigners();

  const oldId = BigInt(process.env.OLD_AGENT_ID ?? "2");
  const operator = process.env.HEARTBEAT_OPERATOR!;
  if (!operator) throw new Error("Set HEARTBEAT_OPERATOR");

  const oldBalance: bigint = await quaestor.balanceOf(oldId);
  if (oldBalance > 0n) {
    await (await quaestor.connect(owner).withdraw(oldId, oldBalance, owner.address)).wait();
    console.log(`Recovered ${ethers.formatEther(oldBalance)} OKB from agent #${oldId}`);
  }
  const info = await quaestor.agents(oldId);
  if (!info.suspended) {
    await (await quaestor.connect(owner).suspend(oldId)).wait();
    console.log(`Agent #${oldId} suspended (retired)`);
  }

  const cap = (v: string) => ethers.parseEther(v);
  const tx = await quaestor.connect(owner).registerAgent(
    operator,
    3600,
    JSON.stringify({ name: "Pulse — governed heartbeat" }),
    { epochCap: cap("0.001"), perCallCap: cap("0.0001") },
    { epochCap: 0n, perCallCap: 0n },
    { epochCap: cap("0.001"), perCallCap: cap("0.0005") },
    { value: oldBalance > 0n ? oldBalance : ethers.parseEther("0.004") }
  );
  const rcpt = await tx.wait();
  const registered = rcpt!.logs
    .map((l) => {
      try {
        return quaestor.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p) => p?.name === "AgentRegistered");
  console.log(`Registered "Pulse — governed heartbeat" as agent #${registered?.args.agentId}`);
  console.log(`  operator ${operator} (reused)`);
  console.log(`  tx ${rcpt!.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
