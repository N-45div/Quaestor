/**
 * Prepare the two wallets the Solana payment lane needs on devnet.
 *
 *   npx ts-node solana/scripts/x402-devnet-setup.ts
 *
 *   revenue — where Quaestor is paid. Its USDC account is created here, because
 *             the x402 SVM client transfers straight into the recipient's
 *             associated token account and does not create it: a missing
 *             account fails every payment.
 *   agent   — the wallet an agent pays from. It needs Circle devnet USDC from
 *             faucet.circle.com; it never needs SOL, because PayAI pays the
 *             network fee.
 *
 * Keys live beside the deployer's in WSL, outside the repo. Prints the env the
 * hub and the paying client need.
 */
import * as dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAccount, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";

dotenv.config();

const RPC = process.env.SOLANA_DEVNET_RPC_URL;
if (!RPC) throw new Error("SOLANA_DEVNET_RPC_URL is required");
const WSL_HOME = process.env.WSL_HOME ?? "//wsl.localhost/Ubuntu-24.04/home/divijn";
const DEPLOYER = process.env.DEVNET_DEPLOYER_KEYPAIR ?? `${WSL_HOME}/.config/solana/id.json`;
const KEYS = process.env.DEVNET_KEYS_DIR ?? `${WSL_HOME}/quaestor-target/devnet`;
const USDC_DEVNET = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const load = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
function keypairAt(name: string): Keypair {
  const path = `${KEYS}/${name}.json`;
  if (existsSync(path)) return load(path);
  mkdirSync(KEYS, { recursive: true });
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify([...kp.secretKey]));
  return kp;
}

async function usdcBalance(conn: Connection, owner: PublicKey): Promise<string> {
  try {
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const ata = getAssociatedTokenAddressSync(USDC_DEVNET, owner, false, TOKEN_PROGRAM_ID);
    return (Number((await getAccount(conn, ata, "confirmed", TOKEN_PROGRAM_ID)).amount) / 1e6).toString();
  } catch {
    return "0 (no USDC account yet)";
  }
}

async function main(): Promise<void> {
  const conn = new Connection(RPC!, "confirmed");
  const deployer = load(DEPLOYER);
  const revenue = keypairAt("revenue");
  const agent = keypairAt("agent");

  // Paid for by the deployer; owned by the revenue address.
  const ata = await getOrCreateAssociatedTokenAccount(conn, deployer, USDC_DEVNET, revenue.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID);

  console.log(`revenue  ${revenue.publicKey.toBase58()}  USDC account ${ata.address.toBase58()}  balance ${await usdcBalance(conn, revenue.publicKey)}`);
  console.log(`agent    ${agent.publicKey.toBase58()}  USDC ${await usdcBalance(conn, agent.publicKey)}`);
  console.log(`\nhub:    X402_SOLANA_ENABLED=1 X402_SOLANA_PAY_TO=${revenue.publicKey.toBase58()}`);
  console.log(`client: SOLANA_AGENT_KEYPAIR=${KEYS}/agent.json`);
  console.log(`\nfund the agent with devnet USDC at https://faucet.circle.com → Solana Devnet → ${agent.publicKey.toBase58()}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
