/**
 * Give the Operator a key held by Circle: one run, with only CIRCLE_API_KEY in .env.
 *
 *   npx ts-node scripts/circle-operator-wallet.ts [--handover 0xGovernor]
 *
 * 1. If .env has no CIRCLE_ENTITY_SECRET, makes one, registers it with Circle, writes it to .env
 *    and Circle's recovery file to ~/.secrets (keep that offline: it is the only way back).
 * 2. If .env has no OP_CIRCLE_WALLET_ARC_TESTNET, makes a wallet set and an Arc testnet wallet.
 * 3. Asks Circle's faucet for test USDC, the wallet's gas on Arc.
 * 4. With --handover, the governor's owner (PRIVATE_KEY) names the Circle wallet its operator.
 *
 * Prints addresses and ids only; never a key or a secret.
 */
import * as dotenv from "dotenv";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { ethers } from "ethers";
import { CircleClient } from "../operator/circle";
import { OP_NETWORKS } from "../operator/networks";

const ENV = path.resolve(".env");
dotenv.config({ path: ENV });

function append(name: string, value: string) {
  const text = fs.readFileSync(ENV, "utf8");
  fs.appendFileSync(ENV, `${text.endsWith("\n") ? "" : "\n"}${name}=${value}\n`);
  process.env[name] = value;
}

async function main() {
  const net = OP_NETWORKS["arc-testnet"];
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) throw new Error("put CIRCLE_API_KEY (Circle Developer Console → API keys, a testnet key) in .env first");

  let secret = process.env.CIRCLE_ENTITY_SECRET;
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    const recovery = await new CircleClient({ apiKey, entitySecret: secret }).registerEntitySecret();
    const dir = path.join(os.homedir(), ".secrets");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `circle-entity-recovery-${new Date().toISOString().slice(0, 10)}.dat`);
    fs.writeFileSync(file, recovery);
    append("CIRCLE_ENTITY_SECRET", secret);
    console.log(`registered a new entity secret; recovery file at ${file}`);
  }
  const circle = new CircleClient({ apiKey, entitySecret: secret });

  let walletId = process.env.OP_CIRCLE_WALLET_ARC_TESTNET;
  if (!walletId) {
    const set = await circle.createWalletSet("quaestor-operator");
    const w = await circle.createWallet(set, net.circleChain);
    walletId = w.id;
    append("OP_CIRCLE_WALLET_ARC_TESTNET", walletId);
    console.log(`created wallet ${walletId} at ${w.address}`);
  }
  const wallet = await circle.wallet(walletId);
  console.log(`operator wallet ${wallet.address} on ${wallet.blockchain} (${wallet.state})`);

  try {
    await circle.drip(wallet.address, net.circleChain);
    console.log("asked Circle's faucet for test USDC");
  } catch (e) {
    console.log(`faucet: ${(e as Error).message} (fund it at faucet.circle.com instead)`);
  }

  const i = process.argv.indexOf("--handover");
  if (i > 0) {
    const governor = process.argv[i + 1];
    if (!governor || !ethers.isAddress(governor)) throw new Error("--handover needs the governor's address");
    const provider = new ethers.JsonRpcProvider(net.rpcUrl, net.chainId, { staticNetwork: true });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
    const g = new ethers.Contract(governor, ["function setOperator(address operator)", "function operator() view returns (address)"], owner);
    const tx = await g.setOperator(wallet.address, { maxFeePerGas: ethers.parseUnits("40", "gwei"), maxPriorityFeePerGas: ethers.parseUnits("1", "gwei") });
    await tx.wait();
    console.log(`governor ${governor} now operated by ${await g.operator()} (tx ${tx.hash})`);
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
