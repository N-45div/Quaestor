import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Prove, on whatever chain you point it at, that the cap is the product.
 *
 *   npx hardhat run scripts/prove-caps.ts --network arcTestnet
 *
 * Three facts, in order, each with a transaction hash or a decoded revert:
 *   1. a spend inside the per-call cap succeeds and emits a Receipt whose
 *      metaHash is the keccak of the decision record;
 *   2. the same spend, one wei over the per-call cap, reverts with the named
 *      custom error PerCallCapExceeded — nobody said "no", the chain did;
 *   3. remainingBudget falls by exactly the amount spent.
 *
 * On Arc the native token is USDC, so every number printed here is dollars and
 * the caps are dollar caps with no change to the contract.
 *
 * Env: OPERATOR_KEY (the agent's operator), AGENT_ID (default 1),
 *      GAS_TOPUP (native to send the operator if it cannot pay gas, default 0.3).
 */
async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name === "localhost" ? "local" : network.name}.json`);
  const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  const address: string = deployment.contracts.Quaestor;
  const agentId = BigInt(process.env.AGENT_ID ?? 1);

  const operatorKey = process.env.OPERATOR_KEY;
  if (!operatorKey) throw new Error("OPERATOR_KEY is required");
  const [owner] = await ethers.getSigners();
  const operator = new ethers.Wallet(operatorKey, ethers.provider);
  const quaestor = await ethers.getContractAt("Quaestor", address);
  const asOperator = quaestor.connect(operator) as typeof quaestor;

  const native = network.name.startsWith("arc") ? "USDC" : "native";
  const fmt = (v: bigint) => `${ethers.formatEther(v)} ${native}`;
  console.log(`Quaestor ${address} on ${network.name} (agent #${agentId})`);

  // The operator pays its own gas; top it up from the owner if it is dry.
  //
  // The top-up has to scale with the chain rather than be a fixed number. On Arc
  // the gas token is USDC and the owner holds tens of it; on an L2 testnet the
  // owner may hold hundredths of an ETH. A flat default big enough for the first
  // is an OutOfFunds on the second, so take a tenth of what the owner has.
  const opBal = await ethers.provider.getBalance(operator.address);
  const floor = ethers.parseEther(process.env.GAS_FLOOR ?? "0.002");
  if (opBal < floor) {
    const ownerBal = await ethers.provider.getBalance(owner.address);
    const topup = process.env.GAS_TOPUP ? ethers.parseEther(process.env.GAS_TOPUP) : ownerBal / 10n;
    if (topup === 0n || topup > ownerBal) {
      throw new Error(
        `owner ${owner.address} holds ${fmt(ownerBal)} — not enough to fund the operator's gas`,
      );
    }
    console.log(`Operator ${operator.address} has ${fmt(opBal)}; sending ${fmt(topup)} for gas`);
    await (await owner.sendTransaction({ to: operator.address, value: topup })).wait();
  }

  const DATA = 0;
  const policy = await quaestor.policyOf(agentId, DATA);
  const before = await quaestor.remainingBudget(agentId, DATA);
  console.log(`\nDATA policy — per-call cap ${fmt(policy.perCallCap)}, epoch cap ${fmt(policy.epochCap)}`);
  console.log(`Remaining this epoch: ${fmt(before)}`);

  // 1 — a spend inside the cap.
  const decision = {
    agent: `Cato on ${network.name}`,
    at: new Date().toISOString(),
    thesis: "buy one market signal before sizing a trade",
    rule: "DATA spend, inside the per-call cap the owner set",
  };
  const record = JSON.stringify(decision);
  const metaHash = ethers.keccak256(ethers.toUtf8Bytes(record));
  const amount = policy.perCallCap / 2n;
  console.log(`\n1. pay(DATA, ${fmt(amount)}) — inside the cap`);
  const tx = await asOperator.pay(agentId, DATA, owner.address, amount, metaHash);
  const rc = await tx.wait();
  console.log(`   mined ${rc!.hash}  gas ${rc!.gasUsed}`);
  console.log(`   metaHash ${metaHash}`);
  console.log(`   decision record: ${record}`);
  console.log(`   → anyone can keccak256 that record and get the metaHash the chain stored`);

  // 2 — one wei over the per-call cap.
  const over = policy.perCallCap + 1n;
  console.log(`\n2. pay(DATA, ${fmt(over)}) — one wei over the per-call cap`);
  try {
    await asOperator.pay.staticCall(agentId, DATA, owner.address, over, metaHash);
    console.log("   UNEXPECTED: the call did not revert");
  } catch (err) {
    const data = (err as { data?: string }).data;
    let decoded = "";
    try {
      const parsed = data ? quaestor.interface.parseError(data) : null;
      if (parsed) decoded = `${parsed.name}(${parsed.args.map((a: unknown) => String(a)).join(", ")})`;
    } catch {
      /* fall through to the raw message */
    }
    console.log(`   reverted: ${decoded || (err as Error).message.split("\n")[0]}`);
    console.log("   → the refusal is the agent's own on-chain budget, not our server");
  }

  // 3 — the budget moved by exactly the amount spent.
  const after = await quaestor.remainingBudget(agentId, DATA);
  console.log(`\n3. Remaining this epoch: ${fmt(after)}  (was ${fmt(before)}, spent ${fmt(before - after)})`);

  const explorer = process.env.EXPLORER_TX;
  if (explorer) console.log(`\n${explorer}${rc!.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
