import * as dotenv from "dotenv";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import {
  ExactHederaScheme,
  HBAR_ASSET_ID,
  HEDERA_TESTNET_CAIP2,
  PrivateKey,
  createClientHederaSigner,
} from "@x402/hedera";

dotenv.config();

/**
 * The paying side of the Hedera lane: an agent that buys one Quaestor decision.
 *
 *   npx ts-node scripts/pay-hedera.ts [path]      (default: /v1/threat/lookup?venue=0xdead...)
 *
 * Flow, printed step by step so the demo can show it:
 *   1. plain GET → 402 with PAYMENT-REQUIRED (decoded and shown)
 *   2. sign a partial HBAR/HTS TransferTransaction with HEDERA_PRIVATE_KEY
 *   3. retry with PAYMENT-SIGNATURE → the resource server verifies + settles
 *      through the Blocky402 facilitator → 200 + PAYMENT-RESPONSE carrying
 *      the Hedera transaction id, resolvable on the mirror node / HashScan.
 *
 * Needs: HEDERA_ACCOUNT_ID (0.0.x), HEDERA_PRIVATE_KEY (ECDSA hex), and a
 * running services process with X402_HEDERA_ENABLED=1 (SERVICES_URL).
 */
async function main() {
  const accountId = required("HEDERA_ACCOUNT_ID");
  const keyHex = required("HEDERA_PRIVATE_KEY").replace(/^0x/, "");
  // SERVICES_URL is set to the deployed hub in .env, so this script pays the
  // *deployed* service unless you override it. A route you just added locally
  // will 404 here and read like a routing bug in code you are staring at.
  //   SERVICES_URL=http://localhost:8402 npx ts-node scripts/pay-hedera.ts …
  const base = (process.env.SERVICES_URL ?? "http://localhost:8402").replace(/\/$/, "");
  console.log(`   against ${base}`);
  const path =
    process.argv[2] ?? "/v1/threat/lookup?venue=0x000000000000000000000000000000000000dEaD";
  const url = `${base}${path}`;

  // Step 1 — see the challenge before paying it.
  const probe = await fetch(url);
  console.log(`1. GET ${path} → ${probe.status}`);
  const required402 = probe.headers.get("payment-required");
  if (probe.status !== 402 || !required402) {
    console.log("   (not gated — body follows)");
    console.log(await probe.text());
    return;
  }
  const challenge = JSON.parse(Buffer.from(required402, "base64").toString("utf8"));
  const accepts = challenge.accepts?.[0] ?? {};
  console.log(
    `   PAYMENT-REQUIRED: network=${accepts.network} asset=${accepts.asset} amount=${accepts.amount} payTo=${accepts.payTo}` +
      (accepts.extra?.feePayer ? ` feePayer=${accepts.extra.feePayer}` : "")
  );

  // Step 2 — a client that can answer that challenge on Hedera testnet.
  //
  // spendControls is the x402 client's own guardrail, and it is on by default:
  // it refuses any asset `findDefaultAsset` does not recognise. On Hedera the
  // default asset is USDC, so a route priced in native HBAR (asset 0.0.0) is
  // rejected client-side before anything is signed — the agent will not pay in
  // a token it was not told about. That is the same idea as Quaestor's caps,
  // one layer up, so we do not switch it off: we allow exactly HBAR, with an
  // explicit per-payment ceiling in tinybars.
  const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(keyHex), {
    network: HEDERA_TESTNET_CAIP2,
  });
  // Note: `new x402Client({...})` does NOT take a config object — the constructor
  // parameter is a payment-requirements *selector function*, so a config passed
  // there is silently ignored and spend controls stay at their defaults. Use
  // setSpendControls() (or x402Client.fromConfig).
  const maxPerPayment = process.env.X402_MAX_TINYBAR ?? "20000000"; // 0.2 HBAR
  const client = new x402Client()
    .setSpendControls({
      allowedAssets: [
        { network: HEDERA_TESTNET_CAIP2, asset: HBAR_ASSET_ID, maxAmountPerPayment: maxPerPayment },
      ],
    })
    .register(HEDERA_TESTNET_CAIP2, new ExactHederaScheme(signer));
  console.log(`   client will pay in HBAR up to ${Number(maxPerPayment) / 1e8} per request; any other asset is refused unsigned`);
  const payingFetch = wrapFetchWithPayment(fetch, client);

  // Step 3 — pay and read the settlement receipt.
  const started = Date.now();
  const paid = await payingFetch(url);
  const body = await paid.text();
  console.log(`2. paid GET ${path} → ${paid.status} in ${Date.now() - started}ms`);
  const receiptHeader = paid.headers.get("payment-response");
  if (receiptHeader) {
    const receipt = decodePaymentResponseHeader(receiptHeader) as Record<string, unknown>;
    console.log(`   PAYMENT-RESPONSE: ${JSON.stringify(receipt)}`);
    const txId = (receipt.transaction ?? receipt.transactionId) as string | undefined;
    if (txId) {
      console.log(
        `   mirror: https://testnet.mirrornode.hedera.com/api/v1/transactions/${encodeURIComponent(txId)}`
      );
      console.log(`   hashscan: https://hashscan.io/testnet/transaction/${encodeURIComponent(txId)}`);
    }
  }
  // The policy verdict is the interesting one and it does not fit in 600
  // characters, so pretty-print JSON in full and truncate only opaque bodies.
  try {
    console.log(`3. body:\n${JSON.stringify(JSON.parse(body), null, 2)}`);
  } catch {
    console.log(`3. body: ${body.slice(0, 600)}`);
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
