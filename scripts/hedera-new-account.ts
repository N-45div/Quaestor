import * as dotenv from "dotenv";
// Client/Hbar/PrivateKey come from @x402/hedera's re-export so we are guaranteed
// the same SDK instance the payment scheme uses. AccountCreateTransaction is not
// in that re-export, so it comes from the pinned SDK itself — there is exactly
// one copy of @hiero-ledger/sdk (2.85.0) in the tree, which is what keeps this safe.
import { Client, Hbar, PrivateKey } from "@x402/hedera";
import { AccountCreateTransaction } from "@hiero-ledger/sdk";

dotenv.config();

/**
 * Create a second funded ECDSA testnet account, paid for by HEDERA_ACCOUNT_ID.
 *
 *   npx ts-node scripts/hedera-new-account.ts [hbar]
 *
 * Why: an x402 payment must move value from the payer to payTo. If they are the
 * same account the net transfer is zero and verification fails, so the hub needs
 * its own treasury account distinct from the agent that pays it.
 *
 * Prints the new Account ID, EVM address and private key. Nothing is written to
 * .env — paste HEDERA_PAYTO_ACCOUNT_ID yourself.
 */
async function main() {
  const operatorId = (process.env.HEDERA_ACCOUNT_ID ?? "").trim();
  const operatorKeyHex = (process.env.HEDERA_PRIVATE_KEY ?? "").trim().replace(/^0x/, "");
  if (!operatorId || !operatorKeyHex) throw new Error("HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY are required");

  const initial = Number(process.argv[2] ?? 20);
  const operatorKey = PrivateKey.fromStringECDSA(operatorKeyHex);
  const client = Client.forTestnet();
  client.setOperator(operatorId, operatorKey);

  try {
    const newKey = PrivateKey.generateECDSA();
    const evm = newKey.publicKey.toEvmAddress();
    console.log(`Creating an ECDSA account funded with ${initial} HBAR from ${operatorId}…`);
    const receipt = await (
      await new AccountCreateTransaction()
        .setECDSAKeyWithAlias(newKey)
        .setInitialBalance(new Hbar(initial))
        .execute(client)
    ).getReceipt(client);

    const accountId = receipt.accountId?.toString();
    if (!accountId) throw new Error("AccountCreateTransaction returned no account id");

    console.log("");
    console.log(`  Account ID   ${accountId}`);
    console.log(`  EVM address  0x${evm}`);
    console.log(`  Private key  0x${newKey.toStringRaw()}`);
    console.log("");
    console.log("  Put this in .env so the agent pays the hub rather than itself:");
    console.log(`    HEDERA_PAYTO_ACCOUNT_ID=${accountId}`);
    console.log(`  https://hashscan.io/testnet/account/${accountId}`);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
