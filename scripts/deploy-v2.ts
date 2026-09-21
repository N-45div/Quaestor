/**
 * Put QuaestorV2 on a real chain, and set up one agent to trade through it.
 *
 *   npx hardhat run scripts/deploy-v2.ts --network base
 *   DRY_RUN=1 npx hardhat run scripts/deploy-v2.ts --network base   # price it, send nothing
 *
 * Only the governor is deployed. There is no demo AMM and there are no test
 * tokens: the venue is Uniswap, which is already there, and the instrument is
 * USDC, which is already there.
 *
 * What the owner does here, and only the owner can: register the agent, set its
 * caps, allow Uniswap as a venue and USDC as an instrument. After that the
 * operator can trade inside the caps and can change none of it.
 *
 * Every step is skipped if the chain already has it, so a run that dies halfway
 * can simply be repeated.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

/** Verified on Base mainnet on 21 Sep 2026: code present, and the deepest ETH/USDC pool is the 0.3% one. */
const VENUES: Record<number, { name: string; swapRouter02: string; usdc: string; weth: string; fee: number; explorer: string }> = {
  8453: {
    name: "Base",
    swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    weth: "0x4200000000000000000000000000000000000006",
    fee: 3000,
    explorer: "https://basescan.org",
  },
};

const EXECUTION = 2;
const dry = process.env.DRY_RUN === "1";
const eth = (wei: bigint) => `${ethers.formatEther(wei)} ETH`;

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const venue = VENUES[chainId];
  if (!venue) throw new Error(`no venue addresses recorded for chain ${chainId}; add them before deploying there`);

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  const fee = (await ethers.provider.getFeeData()).gasPrice ?? 0n;
  console.log(`${venue.name} (${chainId}) — deployer ${deployer.address}`);
  console.log(`  holds ${eth(balance)} at ${ethers.formatUnits(fee, "gwei")} gwei\n`);

  // Nothing is deployed against an address with no code: a typo here would send
  // the agent's money to nobody, and the allowlist would make it legitimate.
  for (const [label, address] of [["Uniswap SwapRouter02", venue.swapRouter02], ["USDC", venue.usdc]] as const) {
    const code = await ethers.provider.getCode(address);
    if (code === "0x") throw new Error(`${label} has no code at ${address} on chain ${chainId}`);
    console.log(`  ${label.padEnd(22)} ${address}  ${(code.length - 2) / 2} bytes`);
  }

  const factory = await ethers.getContractFactory("QuaestorV2");
  const deployTx = await factory.getDeployTransaction();
  const deployGas = await ethers.provider.estimateGas({ ...deployTx, from: deployer.address });
  const agentFunding = ethers.parseEther(process.env.AGENT_FUNDING_ETH ?? "0.0005");
  // Four owner transactions follow the deploy; 120k gas each is a generous bound.
  const estimate = (deployGas + 480_000n) * fee + agentFunding;
  console.log(`\n  deploy ${deployGas} gas, plus setup and ${eth(agentFunding)} of agent funding`);
  console.log(`  about ${eth(estimate)} in total`);
  if (balance < estimate) throw new Error(`deployer holds ${eth(balance)}, needs about ${eth(estimate)}`);
  if (dry) return console.log("\ndry run: nothing was sent");

  const statePath = join(__dirname, "..", "deployments", `${network.name}.json`);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const save = () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  let governor = state.contracts?.QuaestorV2;
  if (governor && (await ethers.provider.getCode(governor)) !== "0x") {
    console.log(`\nreusing QuaestorV2 at ${governor}`);
  } else {
    console.log("\ndeploying QuaestorV2...");
    const deployed = await factory.deploy();
    await deployed.waitForDeployment();
    governor = await deployed.getAddress();
    state.network = network.name;
    state.chainId = chainId;
    state.deployedAt = new Date().toISOString();
    state.contracts = { ...state.contracts, QuaestorV2: governor };
    // Written before anything else runs: what was paid for must not depend on
    // the rest of this script finishing.
    save();
    console.log(`  QuaestorV2 ${governor}  ${venue.explorer}/address/${governor}`);
  }

  const contract = await ethers.getContractAt("QuaestorV2", governor);
  const operator = process.env.AGENT_OPERATOR ?? deployer.address;
  let agentId = state.agent?.id ? BigInt(state.agent.id) : 0n;
  if (agentId === 0n || (await contract.agents(agentId)).owner === ethers.ZeroAddress) {
    const tx = await contract.registerAgent(operator, 86_400, process.env.AGENT_METADATA ?? "https://gitlab.com/ndivij2004/quaestor", { value: agentFunding });
    const receipt = await tx.wait();
    // Read from the event this very transaction emitted, not from a later call
    // to nextAgentId: a public endpoint can answer that from a block before
    // this one, and the id would come back one short and point at no agent.
    const registered = receipt?.logs
      .map((log) => { try { return contract.interface.parseLog(log); } catch { return null; } })
      .find((parsed) => parsed?.name === "AgentRegistered");
    if (!registered) throw new Error(`registerAgent landed in ${tx.hash} but emitted no AgentRegistered; read the id from that transaction before re-running`);
    agentId = registered.args.agentId as bigint;
    state.agent = { id: agentId.toString(), operator, fundedWei: agentFunding.toString(), registerTx: tx.hash };
    save();
    console.log(`  agent ${agentId} registered to operator ${operator}, funded with ${eth(agentFunding)}`);
  } else {
    console.log(`  reusing agent ${agentId}`);
  }

  const perCall = ethers.parseEther(process.env.AGENT_PER_CALL_ETH ?? "0.0002");
  const perEpoch = ethers.parseEther(process.env.AGENT_EPOCH_ETH ?? "0.0004");
  const [epochCap, perCallCap] = await contract.policyOf(agentId, EXECUTION);
  if (epochCap !== perEpoch || perCallCap !== perCall) {
    await (await contract.setPolicy(agentId, EXECUTION, perEpoch, perCall)).wait();
    console.log(`  caps set: ${eth(perCall)} a trade, ${eth(perEpoch)} a day`);
  }
  if (!(await contract.venueAllowed(agentId, venue.swapRouter02))) {
    await (await contract.setVenue(agentId, venue.swapRouter02, true)).wait();
    console.log("  Uniswap allowed as a venue");
  }
  if (!(await contract.instrumentAllowed(agentId, venue.usdc))) {
    await (await contract.setInstrument(agentId, venue.usdc, true)).wait();
    console.log("  USDC allowed as an instrument");
  }

  state.venue = { name: "uniswap-v3", swapRouter02: venue.swapRouter02, usdc: venue.usdc, weth: venue.weth, fee: venue.fee };
  state.policy = { category: "EXECUTION", perCallWei: perCall.toString(), epochWei: perEpoch.toString(), epochLengthSeconds: 86_400 };
  save();

  const left = await ethers.provider.getBalance(deployer.address);
  console.log(`\ndone. deployer spent ${eth(balance - left)}, holds ${eth(left)}`);
  console.log(`state written to deployments/${network.name}.json`);
}

main().catch((error) => {
  console.error(String((error as Error).message ?? error));
  process.exitCode = 1;
});
