/**
 * Fund the devnet faucet: a key of its own, holding a supply of the test USDC
 * every governor here is funded in, and some SOL to give out and pay fees.
 *
 *   SOLANA_DEVNET_RPC_URL=... npm run stocks:faucet:fund
 *
 * The deployer is the only mint authority for that test USDC, and it never
 * goes on a host; this runs on the machine that already holds it (in WSL),
 * mints to the faucet, and tops up its SOL. The hub is then given the faucet
 * key alone, as FAUCET_SECRET: the JSON array in the file this prints.
 * Running it again tops the faucet back up to the targets.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

const RPC = process.env.SOLANA_DEVNET_RPC_URL;
if (!RPC) throw new Error("SOLANA_DEVNET_RPC_URL is required");
const WSL_HOME = process.env.WSL_HOME ?? "//wsl.localhost/Ubuntu-24.04/home/divijn";
const DEPLOYER = process.env.DEVNET_DEPLOYER_KEYPAIR ?? `${WSL_HOME}/.config/solana/id.json`;
const KEYS = process.env.DEVNET_KEYS_DIR ?? `${WSL_HOME}/quaestor-target/devnet`;
const USDC_MINT = new PublicKey(process.env.FAUCET_USDC_MINT ?? "8HcqMLJJxoG3fAkgNk8Qm3Uv7oXhXLM8X5xE4FXZe3Cg");
const USDC_TARGET = BigInt(Math.round(Number(process.env.FAUCET_USDC_TARGET ?? "100000") * 1e6));
const SOL_TARGET = Math.round(Number(process.env.FAUCET_SOL_TARGET ?? "2") * LAMPORTS_PER_SOL);

const load = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));

async function main() {
  const conn = new Connection(RPC!, "confirmed");
  const deployer = load(DEPLOYER);
  const path = `${KEYS}/faucet.json`;
  let faucet: Keypair;
  if (existsSync(path)) {
    faucet = load(path);
  } else {
    mkdirSync(KEYS, { recursive: true });
    faucet = Keypair.generate();
    writeFileSync(path, JSON.stringify([...faucet.secretKey]), { mode: 0o600 });
    console.log(`made a faucet key at ${path}`);
  }
  console.log(`faucet ${faucet.publicKey.toBase58()}, deployer ${deployer.publicKey.toBase58()}`);

  const lamports = await conn.getBalance(faucet.publicKey);
  if (lamports < SOL_TARGET) {
    const top = SOL_TARGET - lamports;
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: faucet.publicKey, lamports: top }),
    ), [deployer]);
    console.log(`sent ${top / LAMPORTS_PER_SOL} SOL: ${sig}`);
  }

  const account = await getOrCreateAssociatedTokenAccount(conn, deployer, USDC_MINT, faucet.publicKey);
  if (account.amount < USDC_TARGET) {
    const top = USDC_TARGET - account.amount;
    const sig = await mintTo(conn, deployer, USDC_MINT, account.address, deployer, top);
    console.log(`minted ${Number(top) / 1e6} test USDC: ${sig}`);
  }

  const [sol, usdc] = await Promise.all([conn.getBalance(faucet.publicKey), conn.getTokenAccountBalance(account.address)]);
  console.log(`faucet holds ${sol / LAMPORTS_PER_SOL} SOL and ${usdc.value.uiAmountString} test USDC`);
  console.log(`give the hub FAUCET_SECRET = the JSON array in ${path} (never print it)`);
}

main().catch((error) => {
  console.error((error as Error).message ?? error);
  process.exitCode = 1;
});
