import { ethers } from "ethers";
import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Everything that has to be true before the Arc mainnet push.
 *
 *   npx ts-node scripts/arc-preflight.ts
 *
 * Arc mainnet opens 16 Sep 2026 and Circle has not published its chain id or
 * RPC yet — the docs say "Mainnet endpoints and parameters are published
 * separately when available". So this script is built to run *now*, months of
 * hackathon deadline before that: every check that can be settled locally is
 * settled locally, and the ones that need the network report PENDING with the
 * reason rather than a false green.
 *
 * The moment ARC_RPC and ARC_CHAIN_ID exist, the same command turns those
 * PENDINGs into real checks and the deploy is one line.
 *
 * FAIL is a stop. PENDING is not — it is the expected state before launch.
 */

type Status = "PASS" | "FAIL" | "PENDING";
interface Check {
  name: string;
  status: Status;
  detail: string;
}

const checks: Check[] = [];
const add = (name: string, status: Status, detail: string) =>
  checks.push({ name, status, detail });

const ARTIFACTS = path.join(__dirname, "..", "artifacts", "contracts");
const DEPLOYMENTS = path.join(__dirname, "..", "deployments");

/** Deploy order in scripts/deploy.ts — this fixes the addresses. */
const ORDER = ["QuaestorDEX", "qUSD", "qBTC", "Quaestor"] as const;

async function main() {
  // 1 ── the contracts compile, and we know how big they are.
  const sizes: Record<string, number> = {};
  for (const c of ["QuaestorDEX", "TestToken", "Quaestor"]) {
    const p = path.join(ARTIFACTS, `${c}.sol`, `${c}.json`);
    if (!fs.existsSync(p)) {
      add("artifacts compiled", "FAIL", `${c}.json missing — run npx hardhat compile`);
      break;
    }
    const artifact = JSON.parse(fs.readFileSync(p, "utf8"));
    sizes[c] = (artifact.bytecode.length - 2) / 2;
  }
  if (Object.keys(sizes).length === 3) {
    const over = Object.entries(sizes).filter(([, n]) => n > 24_576);
    add(
      "artifacts compiled",
      over.length ? "FAIL" : "PASS",
      over.length
        ? `over the 24576-byte EIP-170 limit: ${over.map(([c, n]) => `${c} ${n}`).join(", ")}`
        : Object.entries(sizes)
            .map(([c, n]) => `${c} ${n}B`)
            .join(", ")
    );
  }

  // 2 ── a deployer key, and which address it is.
  const key = process.env.ARC_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!key) {
    add("deployer key", "FAIL", "neither ARC_PRIVATE_KEY nor PRIVATE_KEY is set");
    return report();
  }
  const deployer = new ethers.Wallet(key).address;
  add(
    "deployer key",
    "PASS",
    `${deployer}${process.env.ARC_PRIVATE_KEY ? " (ARC_PRIVATE_KEY)" : " (PRIVATE_KEY — consider a dedicated mainnet key)"}`
  );

  // 3 ── the addresses are already known, because CREATE is deterministic.
  const predicted = ORDER.map((name, nonce) => ({
    name,
    nonce,
    address: ethers.getCreateAddress({ from: deployer, nonce }),
  }));
  add(
    "addresses predictable",
    "PASS",
    predicted.map((p) => `${p.name}@${p.nonce} ${p.address}`).join("  ")
  );

  // 4 ── and they match what is already live elsewhere, which is the proof
  //      that the mainnet deploy is the same deploy and not a rewrite.
  const parity: string[] = [];
  let mismatch = false;
  for (const file of ["arcTestnet.json", "baseSepolia.json"]) {
    const p = path.join(DEPLOYMENTS, file);
    if (!fs.existsSync(p)) continue;
    const live = JSON.parse(fs.readFileSync(p, "utf8")).contracts?.Quaestor;
    const want = predicted[3].address;
    if (!live) continue;
    const same = live.toLowerCase() === want.toLowerCase();
    if (!same) mismatch = true;
    parity.push(`${file.replace(".json", "")} ${same ? "=" : "≠"} ${live}`);
  }
  add(
    "governor address parity",
    mismatch ? "FAIL" : "PASS",
    parity.length
      ? `${parity.join(", ")} — same deployer at nonce 3, so mainnet lands on the same address if the account is fresh there`
      : "no existing deployments to compare"
  );

  // 5 ── has Circle published mainnet yet?
  const rpc = process.env.ARC_RPC;
  const chainIdEnv = process.env.ARC_CHAIN_ID;
  if (!rpc || !chainIdEnv) {
    add(
      "mainnet parameters",
      "PENDING",
      "ARC_RPC / ARC_CHAIN_ID unset. Arc mainnet opens 16 Sep 2026 and docs.arc.io " +
        "still says mainnet endpoints are published separately. Do NOT take a chain id " +
        "from an aggregator — 5042 and 1243 are both circulating and neither is from Circle."
    );
    // Fall back to Arc *testnet* for a cost estimate, clearly labelled.
    await estimateOn(
      process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.io",
      deployer,
      sizes,
      true
    );
    return report();
  }

  // 6 ── the RPC answers, and its chain id is the one we were told.
  let provider: ethers.JsonRpcProvider;
  try {
    provider = new ethers.JsonRpcProvider(rpc);
    const net = await provider.getNetwork();
    const actual = net.chainId.toString();
    const same = actual === String(Number(chainIdEnv));
    add(
      "chain id matches",
      same ? "PASS" : "FAIL",
      same
        ? `${actual} from ${rpc}`
        : `ARC_CHAIN_ID=${chainIdEnv} but the RPC reports ${actual} — one of them is wrong, and ethers will refuse to send either way`
    );
    if (!same) return report();
  } catch (err) {
    add("chain id matches", "FAIL", `${rpc} did not answer: ${(err as Error).message.slice(0, 120)}`);
    return report();
  }

  // 7 ── a fresh account, or the predicted addresses are wrong.
  const nonce = await provider.getTransactionCount(deployer);
  add(
    "deployer is fresh",
    nonce === 0 ? "PASS" : "FAIL",
    nonce === 0
      ? "nonce 0 — the predicted addresses above are what you will get"
      : `nonce ${nonce} — every address above shifts. Use a fresh account or update the expected addresses.`
  );

  // 8 ── enough USDC. On Arc the gas token IS USDC, 18 decimals, so this
  //      number is dollars and so are the caps the governor enforces.
  await estimateOn(rpc, deployer, sizes, false, provider);
  return report();
}

/**
 * Estimate what the deploy costs and whether the deployer can pay it.
 * When mainnet is not published we run this against Arc *testnet* so the number
 * is measured rather than guessed — labelled, because mainnet gas may differ.
 */
async function estimateOn(
  rpc: string,
  deployer: string,
  sizes: Record<string, number>,
  isTestnetProxy: boolean,
  existing?: ethers.JsonRpcProvider
) {
  const label = isTestnetProxy ? "estimated on Arc testnet" : "on Arc mainnet";
  try {
    const provider = existing ?? new ethers.JsonRpcProvider(rpc);
    const fee = await provider.getFeeData();
    const gasPrice = fee.maxFeePerGas ?? fee.gasPrice;
    if (!gasPrice) {
      add("deploy cost", "PENDING", `${rpc} returned no fee data`);
      return;
    }

    // 200 gas per byte of deployed code plus the intrinsic + execution cost;
    // the constant is deliberately generous — this is a "can you afford it"
    // check, not an invoice.
    const totalBytes = sizes.QuaestorDEX + sizes.TestToken * 2 + sizes.Quaestor;
    const gas = BigInt(Math.ceil(totalBytes * 260 + 500_000));
    const cost = gas * gasPrice;
    // deploy.ts also seeds two pools from SEED_NATIVE_*.
    const seed =
      ethers.parseEther(process.env.SEED_NATIVE_QUSD ?? "0.2") +
      ethers.parseEther(process.env.SEED_NATIVE_QBTC ?? "0.2");
    const need = cost + seed;

    const bal = await provider.getBalance(deployer);
    const enough = bal >= need;
    add(
      "deployer funded",
      isTestnetProxy ? "PENDING" : enough ? "PASS" : "FAIL",
      `${label}: ~${ethers.formatEther(cost)} gas + ${ethers.formatEther(seed)} seed = ` +
        `~${ethers.formatEther(need)} USDC needed; deployer holds ${ethers.formatEther(bal)}` +
        (isTestnetProxy
          ? " on TESTNET. Fund the mainnet account before 16 Sep."
          : enough
            ? ""
            : " — top up before deploying.")
    );
    add(
      "gas price",
      "PASS",
      `${ethers.formatUnits(gasPrice, "gwei")} gwei (${label}). Arc's gas token is USDC at 18 decimals, so msg.value caps are dollar caps unchanged.`
    );
  } catch (err) {
    add("deploy cost", "PENDING", `${rpc} unreachable: ${(err as Error).message.slice(0, 120)}`);
  }
}

function report() {
  const glyph: Record<Status, string> = { PASS: "✔", FAIL: "✘", PENDING: "…" };
  console.log("\nArc mainnet preflight\n");
  for (const c of checks) {
    console.log(`${glyph[c.status]} ${c.name}`);
    console.log(`    ${c.detail}\n`);
  }
  const failed = checks.filter((c) => c.status === "FAIL");
  const pending = checks.filter((c) => c.status === "PENDING");
  console.log(
    `${checks.length - failed.length - pending.length} pass, ${pending.length} pending, ${failed.length} fail`
  );
  if (pending.length && !failed.length) {
    console.log("\nPending is the expected state until Circle publishes mainnet parameters.");
    console.log("Then: ARC_RPC=… ARC_CHAIN_ID=… npm run arc:preflight && npm run deploy:arc-mainnet");
  }
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
