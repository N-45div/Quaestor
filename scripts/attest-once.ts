import * as dotenv from "dotenv";
import { attestConfigFromEnv, attestTransaction } from "../services/attest";

dotenv.config();

/**
 * Prove one source-chain transaction to the budget root.
 *
 *   npx ts-node scripts/attest-once.ts <sepolia tx hash>
 *
 * Needs ATTESTED_ADDRESS + CREDITCOIN_PRIVATE_KEY (and optionally SEPOLIA_RPC,
 * CREDITCOIN_RPC, PROOF_BUILDER_URL, SOURCE_CHAIN_KEY). Attestation of a fresh
 * Sepolia block typically lands in a few minutes; this waits up to 20.
 */
async function main() {
  const txHash = process.argv[2];
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error("usage: attest-once.ts <0x… source-chain transaction hash>");
  }
  const cfg = attestConfigFromEnv();
  if (!cfg) throw new Error("ATTESTED_ADDRESS and CREDITCOIN_PRIVATE_KEY are required");
  const r = await attestTransaction(cfg, txHash);
  console.log(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`explorer: https://creditcoin-testnet.blockscout.com/tx/${r.creditcoinTx}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
