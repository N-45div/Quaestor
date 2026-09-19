/**
 * Buy a quote-check the way an agent does: ask, be told the price, pay, get the
 * answer — over x402 on Solana, settled in USDC by PayAI.
 *
 * The quote it asks about is a bad one on purpose (5 USDC for a third too few
 * tokens), so the answer worth paying for is visible: `off-market`, with the
 * evidence. The agent wallet needs Circle devnet USDC and nothing else — PayAI
 * pays the network fee.
 *
 *   SOLANA_AGENT_KEYPAIR=path/to/agent.json npm run intel:pay -- [https://host] [instrument]
 */
import { readFileSync } from "node:fs";
import * as dotenv from "dotenv";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { solanaPayingFetch } from "../sdk";
import { safeMessage } from "../stocks/redact";

dotenv.config();

const USDC_DEVNET = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

async function main(): Promise<void> {
  const base = (process.argv[2] ?? "http://127.0.0.1:8402").replace(/\/$/, "");
  const instrument = process.argv[3] ?? "AAPLx";
  const keypairPath = process.env.SOLANA_AGENT_KEYPAIR;
  if (!keypairPath) throw new Error("SOLANA_AGENT_KEYPAIR is not set");
  const secretKey = Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8")));
  const agent = Keypair.fromSecretKey(secretKey);

  const rpcUrl = process.env.SOLANA_DEVNET_RPC_URL;
  if (rpcUrl) {
    const account = getAssociatedTokenAddressSync(USDC_DEVNET, agent.publicKey);
    const balance = await new Connection(rpcUrl, "confirmed")
      .getTokenAccountBalance(account)
      .then((found) => `${found.value.uiAmountString} USDC`, () => "no USDC account yet");
    console.log(`agent ${agent.publicKey.toBase58()} holds ${balance}`);
  }

  const unpaid = await fetch(`${base}/v1/intel/market-evidence?instrument=${encodeURIComponent(instrument)}`);
  console.log(`without paying: HTTP ${unpaid.status}${unpaid.status === 402 ? " — payment required, as it should be" : ""}`);

  const paying = await solanaPayingFetch({ secretKey, rpcUrl });
  const response = await paying.fetch(`${base}/v1/intel/quote-check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instrument, usdc_in: "5000000", tokens_out: "1000000", venue: "some-dex" }),
  });
  const body = (await response.json()) as { verdict?: string; reading?: string; error?: { code: string; message: string } };
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error?.code ?? ""} ${body.error?.message ?? ""}`);
  console.log(`paid:     ${JSON.stringify(paying.lastPayment())}`);
  console.log(`verdict:  ${body.verdict}`);
  console.log(`          ${body.reading}`);
}

main().catch((error) => {
  console.error(`failed: ${safeMessage(error, 300)}`);
  process.exit(1);
});
