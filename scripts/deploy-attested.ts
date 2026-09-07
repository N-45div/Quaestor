import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Deploy the budget root and wire it to a source-chain governor.
 *
 *   npx hardhat run scripts/deploy-attested.ts --network creditcoinTestnet
 *
 * Reads deployments/<SOURCE_NETWORK>.json (default: sepolia) for the governor
 * to register, links SOURCE_AGENT_ID (default 1) into GROUP_ID (default 1) and
 * sets GLOBAL_CAP (ETH-denominated string, default "0.05") per GLOBAL_EPOCH_S
 * (default 3600). Writes deployments/attested-<network>.json.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`Deploying QuaestorAttested to ${network.name} (chain ${net.chainId}) as ${deployer.address}`);
  console.log(`  balance ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))}`);

  const root = await ethers.deployContract("QuaestorAttested");
  await root.waitForDeployment();
  const address = await root.getAddress();
  console.log(`QuaestorAttested at ${address}`);

  const sourceNetwork = process.env.SOURCE_NETWORK ?? "sepolia";
  const sourceChainKey = Number(process.env.SOURCE_CHAIN_KEY ?? 1);
  const groupId = BigInt(process.env.GROUP_ID ?? 1);
  const agentId = BigInt(process.env.SOURCE_AGENT_ID ?? 1);
  const cap = ethers.parseEther(process.env.GLOBAL_CAP ?? "0.05");
  const epochS = Number(process.env.GLOBAL_EPOCH_S ?? 3600);

  const out: Record<string, unknown> = {
    network: network.name,
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    contracts: { QuaestorAttested: address },
    sources: [] as unknown[],
  };

  const sourceFile = path.join(__dirname, "..", "deployments", `${sourceNetwork}.json`);
  if (fs.existsSync(sourceFile)) {
    const src = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
    const governor: string = src.contracts.Quaestor;
    console.log(`Registering source governor ${governor} (${sourceNetwork}, chain key ${sourceChainKey})`);
    await (await root.registerSource(sourceChainKey, governor)).wait();
    await (await root.linkAgent(groupId, governor, agentId)).wait();
    await (await root.setGlobalCap(groupId, cap, epochS)).wait();
    console.log(`  agent #${agentId} → group ${groupId}, global cap ${ethers.formatEther(cap)} per ${epochS}s`);
    (out.sources as unknown[]).push({ network: sourceNetwork, chainKey: sourceChainKey, governor, agentId: agentId.toString(), groupId: groupId.toString(), cap: cap.toString(), epochS });
  } else {
    console.log(`No deployments/${sourceNetwork}.json — deployed without a registered source. Register later with registerSource/linkAgent/setGlobalCap.`);
  }

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `attested-${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nWritten to ${file}`);
  console.log(`Set ATTESTED_ADDRESS=${address} on the hub to serve GET /v1/budget/${groupId}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
