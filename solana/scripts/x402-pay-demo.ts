/**
 * An agent buys one read of the live price tape, in USDC on Solana devnet,
 * settled by PayAI.
 *
 *   npx ts-node solana/scripts/x402-pay-demo.ts
 *
 * Needs the hub running with X402_SOLANA_ENABLED=1, and the agent wallet from
 * x402-devnet-setup.ts holding Circle devnet USDC. The agent holds no SOL:
 * PayAI pays the network fee.
 */
import * as dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { QuaestorStocksApiError, QuaestorStocksClient, solanaPayingFetch } from "../../sdk";

dotenv.config();

const HUB = process.env.STOCKS_API_URL ?? "http://127.0.0.1:8402";
const RPC = process.env.SOLANA_DEVNET_RPC_URL;
const WSL_HOME = process.env.WSL_HOME ?? "//wsl.localhost/Ubuntu-24.04/home/divijn";
const AGENT = process.env.SOLANA_AGENT_KEYPAIR ?? `${WSL_HOME}/quaestor-target/devnet/agent.json`;
const PAY_TO = process.env.X402_SOLANA_PAY_TO ?? "6n1C3qGbRgFJv9Kem77sXLQPMJXS3kXAgN2w28JKi97a";
const USDC_DEVNET = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const AAPLX = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";

async function usdc(conn: Connection, owner: string): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(USDC_DEVNET, new PublicKey(owner), false, TOKEN_PROGRAM_ID);
    return Number((await getAccount(conn, ata, "confirmed", TOKEN_PROGRAM_ID)).amount) / 1e6;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  if (!RPC) throw new Error("SOLANA_DEVNET_RPC_URL is required");
  const conn = new Connection(RPC, "confirmed");
  const secretKey = Uint8Array.from(JSON.parse(readFileSync(AGENT, "utf8")));
  const paying = await solanaPayingFetch({ secretKey, rpcUrl: RPC });

  const before = { agent: await usdc(conn, paying.payer), revenue: await usdc(conn, PAY_TO) };
  console.log(`agent   ${paying.payer}  ${before.agent} USDC`);
  console.log(`revenue ${PAY_TO}  ${before.revenue} USDC\n`);

  const client = new QuaestorStocksClient({ baseUrl: HUB, fetch: paying.fetch });
  try {
    const tape = await client.prices(AAPLX, "1h");
    const receipt = paying.lastPayment();
    console.log(`read the ${tape.instrument.symbol} tape:\n  ${tape.narrative}\n`);
    if (receipt) {
      console.log(`paid via PayAI on ${receipt.network}`);
      console.log(`  https://explorer.solana.com/tx/${receipt.transaction}?cluster=devnet`);
    }
    const after = { agent: await usdc(conn, paying.payer), revenue: await usdc(conn, PAY_TO) };
    console.log(`\nagent ${before.agent} → ${after.agent} USDC · revenue ${before.revenue} → ${after.revenue} USDC`);
  } catch (error) {
    if (error instanceof QuaestorStocksApiError && error.status === 402) {
      console.log(`still 402 after paying: ${error.message}`);
      console.log(before.agent === 0
        ? `the agent holds no devnet USDC — fund ${paying.payer} at https://faucet.circle.com (Solana Devnet)`
        : "the payment was refused — see the facilitator's reason above");
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
