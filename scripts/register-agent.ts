import { ethers, network } from "hardhat";
import type { Log, LogDescription } from "ethers";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Ops helper: register an agent from the deployer/owner key.
 * Normal users do this from the dashboard; this script exists for headless
 * setups (CI, the example agent's own bootstrap).
 *
 * Env:
 *   AGENT_NAME          display name (default "Cato")
 *   AGENT_OPERATOR      operator address (required on live networks;
 *                       defaults to the 2nd local signer on localhost)
 *   AGENT_EPOCH_SECONDS budget epoch (default 3600)
 *   AGENT_DEPOSIT_OKB   initial treasury (default 0.05)
 *   CAP_*               epoch/per-call caps in OKB, see below
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

  const signers = await ethers.getSigners();
  const owner = signers[0];
  let operator = process.env.AGENT_OPERATOR;
  if (!operator) {
    if (network.name !== "localhost") {
      throw new Error("Set AGENT_OPERATOR on live networks.");
    }
    operator = await signers[1].getAddress();
  }

  const name = process.env.AGENT_NAME ?? "Cato";
  const epochLength = Number(process.env.AGENT_EPOCH_SECONDS ?? 3600);
  const depositOkb = process.env.AGENT_DEPOSIT_OKB ?? "0.05";

  const cap = (env: string, dflt: string) =>
    ethers.parseEther(process.env[env] ?? dflt);

  const tx = await quaestor.connect(owner).registerAgent(
    operator,
    epochLength,
    JSON.stringify({ name }),
    { epochCap: cap("CAP_DATA_EPOCH", "0.01"), perCallCap: cap("CAP_DATA_CALL", "0.002") },
    {
      epochCap: cap("CAP_INFERENCE_EPOCH", "0.02"),
      perCallCap: cap("CAP_INFERENCE_CALL", "0.005"),
    },
    {
      epochCap: cap("CAP_EXECUTION_EPOCH", "0.05"),
      perCallCap: cap("CAP_EXECUTION_CALL", "0.01"),
    },
    { value: ethers.parseEther(depositOkb) }
  );
  const rcpt = await tx.wait();

  const registered = rcpt!.logs
    .map((l: Log) => {
      try {
        return quaestor.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p: LogDescription | null) => p?.name === "AgentRegistered");
  const agentId = registered?.args.agentId;

  console.log(`Registered "${name}"`);
  console.log(`  agentId   ${agentId}`);
  console.log(`  operator  ${operator}`);
  console.log(`  epoch     ${epochLength}s, deposit ${depositOkb} OKB`);
  console.log(`  tx        ${rcpt!.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
