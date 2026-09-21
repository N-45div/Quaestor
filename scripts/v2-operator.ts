/**
 * Hand an agent to an operator key of its own, and give that key gas.
 *
 *   BASE_OPERATOR_ADDRESS=0x… OPERATOR_GAS_ETH=0.0004 npx hardhat run scripts/v2-operator.ts --network base
 *
 * The deploy registered the agent with the owner as its own operator, which is
 * fine for a first trade and wrong for a host: the key a hosted agent signs
 * with would then also be the key that withdraws the treasury and rewrites the
 * caps. This makes the operator a separate key. The owner's key stays on this
 * machine; only the operator's goes to the host, and it can trade inside the
 * caps and do nothing else.
 *
 * The operator pays its own gas, so it is sent a little ETH. That ETH is the
 * operator's, outside the governor, and is the most a stolen operator key can
 * spend on anything other than governed trades.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

async function main() {
  const statePath = join(__dirname, "..", "deployments", `${network.name}.json`);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const operator = process.env.BASE_OPERATOR_ADDRESS;
  if (!operator || !ethers.isAddress(operator)) throw new Error("BASE_OPERATOR_ADDRESS is required");
  const agentId = BigInt(state.agent.id);
  const governor = await ethers.getContractAt("QuaestorV2", state.contracts.QuaestorV2);
  const [owner] = await ethers.getSigners();

  const info = await governor.agents(agentId);
  if (info.owner.toLowerCase() !== owner.address.toLowerCase()) throw new Error("this key is not the agent's owner");
  if (operator.toLowerCase() === owner.address.toLowerCase()) throw new Error("the operator must not be the owner");

  if (info.operator.toLowerCase() !== operator.toLowerCase()) {
    const tx = await governor.setOperator(agentId, operator);
    const receipt = await tx.wait();
    // Confirmed from the transaction's own event, not a later read.
    const changed = receipt!.logs.map((l) => { try { return governor.interface.parseLog(l); } catch { return null; } })
      .find((p) => p?.name === "OperatorChanged");
    if (!changed || String(changed.args.operator).toLowerCase() !== operator.toLowerCase()) {
      throw new Error(`setOperator landed in ${tx.hash} without the expected OperatorChanged`);
    }
    state.agent.operator = operator;
    state.agent.operatorTx = tx.hash;
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    console.log(`agent ${agentId} now operated by ${operator}  https://basescan.org/tx/${tx.hash}`);
  } else {
    console.log(`agent ${agentId} is already operated by ${operator}`);
  }

  const want = ethers.parseEther(process.env.OPERATOR_GAS_ETH ?? "0.0004");
  const has = await ethers.provider.getBalance(operator);
  if (has < want / 2n) {
    const tx = await owner.sendTransaction({ to: operator, value: want - has });
    await tx.wait();
    state.agent.gasFundedWei = String(want - has);
    state.agent.gasFundTx = tx.hash;
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    console.log(`sent the operator ${ethers.formatEther(want - has)} ETH for gas  https://basescan.org/tx/${tx.hash}`);
  } else {
    console.log(`operator already holds ${ethers.formatEther(has)} ETH for gas`);
  }
}

main().catch((error) => {
  console.error(String((error as Error).message ?? error));
  process.exitCode = 1;
});
