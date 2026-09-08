import * as dotenv from "dotenv";
import { PrivateKey } from "@x402/hedera";

dotenv.config();

/**
 * Check every assumption the Hedera x402 lane makes, before we spend time on it.
 *
 *   npx ts-node scripts/hedera-preflight.ts
 *
 * Verifies, in order and with the actual failure named:
 *   1. HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY are present and well-formed
 *   2. the key is ECDSA (ED25519 keys cannot back an EVM alias and the signer needs ECDSA)
 *   3. the account exists on the mirror node, is not deleted, and is funded
 *   4. the key in .env actually controls that account (public keys match)
 *   5. the payTo account exists
 *   6. the Blocky402 facilitator is live and advertises hedera:testnet
 * Nothing here signs or spends.
 */

const MIRROR = process.env.HEDERA_MIRROR_URL ?? "https://testnet.mirrornode.hedera.com";
const FACILITATOR = process.env.BLOCKY402_URL ?? "https://api.testnet.blocky402.com";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

async function mirrorAccount(id: string): Promise<Record<string, any> | null> {
  const r = await fetch(`${MIRROR}/api/v1/accounts/${encodeURIComponent(id)}`);
  if (!r.ok) return null;
  return (await r.json()) as Record<string, any>;
}

async function main() {
  const accountId = (process.env.HEDERA_ACCOUNT_ID ?? "").trim();
  const keyRaw = (process.env.HEDERA_PRIVATE_KEY ?? "").trim();
  const payTo = (process.env.HEDERA_PAYTO_ACCOUNT_ID ?? accountId).trim();

  // 1 — present and well-formed
  const idOk = /^\d+\.\d+\.\d+$/.test(accountId);
  add(
    "HEDERA_ACCOUNT_ID",
    idOk,
    idOk
      ? accountId
      : accountId
        ? `${JSON.stringify(accountId)} is not a Hedera account id — use the portal's "Account ID" (0.0.x), not the EVM address`
        : "missing"
  );
  add("HEDERA_PRIVATE_KEY", keyRaw.length > 0, keyRaw ? `${keyRaw.length} chars` : "missing");
  if (!idOk || !keyRaw) return report();

  // 2 — ECDSA, parseable
  let key: ReturnType<typeof PrivateKey.fromStringECDSA> | null = null;
  try {
    key = PrivateKey.fromStringECDSA(keyRaw.replace(/^0x/, ""));
    add("key is ECDSA secp256k1", true, `evm address ${key.publicKey.toEvmAddress()}`);
  } catch (err) {
    let hint = (err as Error).message;
    try {
      PrivateKey.fromStringED25519(keyRaw.replace(/^0x/, ""));
      hint = "this is an ED25519 key — the x402 Hedera signer needs ECDSA. In the portal, switch the key type to ECDSA and copy that one.";
    } catch {
      /* keep the parse error */
    }
    add("key is ECDSA secp256k1", false, hint);
    return report();
  }

  // 3 — the account exists and is funded
  const acct = await mirrorAccount(accountId);
  if (!acct) {
    add("account on mirror node", false, `${accountId} not found on ${MIRROR} — is it a testnet account?`);
    return report();
  }
  const hbar = Number(acct.balance?.balance ?? 0) / 1e8;
  add("account on mirror node", !acct.deleted, acct.deleted ? "account is DELETED" : `${accountId} · evm ${acct.evm_address}`);
  add("funded", hbar >= 1, `${hbar} HBAR${hbar < 1 ? " — top up at portal.hedera.com" : ""}`);
  add(
    "account key type",
    (acct.key?._type ?? "").includes("ECDSA"),
    acct.key?._type ?? "unknown"
  );

  // 4 — the key controls the account
  const onChainKey = String(acct.key?.key ?? "").toLowerCase().replace(/^0x/, "");
  const localKey = key.publicKey.toStringRaw().toLowerCase().replace(/^0x/, "");
  const matches = onChainKey.length > 0 && (onChainKey === localKey || onChainKey.endsWith(localKey) || localKey.endsWith(onChainKey));
  add(
    "key controls the account",
    matches,
    matches ? "public keys match" : `mirror says ${onChainKey.slice(0, 20)}…, .env key is ${localKey.slice(0, 20)}… — wrong account/key pair`
  );

  // 5 — payTo
  if (payTo !== accountId) {
    const p = await mirrorAccount(payTo);
    add("HEDERA_PAYTO_ACCOUNT_ID", !!p && !p.deleted, p ? `${payTo} exists` : `${payTo} not found`);
  } else {
    add("HEDERA_PAYTO_ACCOUNT_ID", true, `${payTo} (same account — settlements pay yourself, fine for a demo)`);
  }

  // 6 — the facilitator
  try {
    const r = await fetch(`${FACILITATOR}/supported`);
    const body = (await r.json()) as { kinds?: { network: string; extra?: Record<string, unknown> }[] };
    const hedera = (body.kinds ?? []).filter((k) => k.network.startsWith("hedera:"));
    add(
      "Blocky402 facilitator",
      hedera.length > 0,
      hedera.length ? hedera.map((k) => `${k.network} feePayer=${(k.extra as any)?.feePayer ?? "?"}`).join(", ") : `${FACILITATOR} lists no hedera network`
    );
  } catch (err) {
    add("Blocky402 facilitator", false, `${FACILITATOR} unreachable: ${(err as Error).message}`);
  }

  report();
}

function report() {
  const pad = Math.max(...checks.map((c) => c.name.length));
  console.log("");
  for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(pad)}  ${c.detail}`);
  const failed = checks.filter((c) => !c.ok);
  console.log("");
  if (failed.length === 0) {
    console.log("  Ready. Start the hub with X402_HEDERA_ENABLED=1, then:");
    console.log("    npx ts-node scripts/pay-hedera.ts");
  } else {
    console.log(`  ${failed.length} check(s) failed — fix the first one and re-run.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
