/**
 * Launch a reference-anchored Meteora DBC pool, and write down what every step
 * cost. Devnet by default; `--cluster mainnet` is the same launch with real SOL.
 *
 *   npx ts-node solana/scripts/dbc-devnet.ts              # plan, launch, one small buy
 *   npx ts-node solana/scripts/dbc-devnet.ts --plan       # print the plan and stop
 *   npx ts-node solana/scripts/dbc-devnet.ts --band 500 --raise 20000
 *   npx ts-node solana/scripts/dbc-devnet.ts --rehearse-mainnet   # mainnet's exact parameters, on devnet
 *   npx ts-node solana/scripts/dbc-devnet.ts --cluster mainnet    # launch only; no buy is made
 *
 * The reference price is not typed in. It is read from the hub's price gate,
 * which takes it from sources that have nothing to do with this pool; if the
 * gate has no fresh price the script stops, because a curve anchored to a guess
 * is not anchored.
 *
 * Rent is the same on every cluster, so the lamports a devnet launch records
 * are what the same launch costs on mainnet. They go, with the addresses, into
 * deployments/solana-<cluster>.json. Re-running reuses the pool.
 *
 * A launch is two transactions, and on mainnet the second failing must not cost
 * a second config. So the two new keypairs are saved, outside the repository,
 * before anything is sent, and a re-run looks at the chain and carries on from
 * whichever step is missing.
 */
import * as dotenv from "dotenv";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import BN from "bn.js";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  DynamicBondingCurveClient,
  TokenDecimal,
  deriveDbcPoolAddress,
  getPriceFromSqrtPrice,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { send, UnresolvedSubmission } from "../client";
import { planStockLaunch, premiumBps } from "../../stocks/dbc-launch";
import { dbcCurrentPoint } from "../../stocks/dbc-venue";

dotenv.config();

const flag = (name: string) => process.argv.includes(`--${name}`);
const text = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const arg = (name: string, fallback: number): number => Number(text(name) ?? fallback);

const mainnet = text("cluster") === "mainnet";
const rehearsal = flag("rehearse-mainnet");
if (mainnet && rehearsal) throw new Error("--rehearse-mainnet runs on devnet; it cannot be combined with --cluster mainnet");
const cluster = mainnet ? "mainnet" : "devnet";
/** What mainnet is launched with; the rehearsal uses exactly these, so it tests what will be signed. */
const asMainnet = mainnet || rehearsal;

const DEVNET_RPC = process.env.SOLANA_DEVNET_RPC_URL;
if (!DEVNET_RPC) throw new Error("SOLANA_DEVNET_RPC_URL is required");
const RPC = mainnet
  ? (process.env.SOLANA_MAINNET_RPC_URL ?? DEVNET_RPC.replace("devnet.helius-rpc.com", "mainnet.helius-rpc.com"))
  : DEVNET_RPC;
if (mainnet && RPC === DEVNET_RPC) throw new Error("no mainnet RPC: set SOLANA_MAINNET_RPC_URL");

const WSL_HOME = process.env.WSL_HOME ?? "//wsl.localhost/Ubuntu-24.04/home/divijn";
// Mainnet is paid for by a key made for this and nothing else. The devnet
// deployer is the programs' upgrade authority and has no business holding real SOL.
const PAYER = mainnet
  ? (process.env.MAINNET_DBC_LAUNCHER_KEYPAIR ?? `${WSL_HOME}/quaestor-target/mainnet/dbc-launcher.json`)
  : (process.env.DEVNET_DEPLOYER_KEYPAIR ?? `${WSL_HOME}/.config/solana/id.json`);
const KEYS_DIR = `${WSL_HOME}/quaestor-target/${cluster}`;
const DEVNET_STATE = join(__dirname, "..", "..", "deployments", "solana-devnet.json");
const STATE = mainnet ? join(__dirname, "..", "..", "deployments", "solana-mainnet.json") : DEVNET_STATE;
/** Where in the state file this launch is recorded. A rehearsal must not overwrite the curve the hub trades. */
const SLOT = rehearsal ? "dbc_mainnet_rehearsal" : "dbc";
const PENDING = `${KEYS_DIR}/dbc-launch-${SLOT}.json`;

const HUB = process.env.STOCKS_API_URL_PUBLIC ?? "https://quaestor-stocks.onrender.com";
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const REPO_RAW = "https://gitlab.com/ndivij2004/quaestor/-/raw/main/solana/dbc";
/**
 * What the token says about itself. Served from the repository so it cannot
 * drift from it. On mainnet the name carries no company's ticker: real people
 * can buy it with real money, and a disclaimer in the metadata does not undo a
 * name that reads like a share.
 */
const TOKEN = asMainnet
  ? { name: "Quaestor Anchored Curve (demo)", symbol: "QANCHOR", uri: `${REPO_RAW}/metadata-mainnet.json` }
  : { name: "Quaestor AAPL curve (demo)", symbol: "qAAPLdemo", uri: `${REPO_RAW}/metadata.json` };
const DEFAULT_RAISE = asMainnet ? 5_000 : 50_000;

const planOnly = flag("plan");
const SOL = (lamports: number) => (lamports / 1e9).toFixed(6);
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}${mainnet ? "" : "?cluster=devnet"}`;
const loadKeypair = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));

interface Reference { price: number; sources: string[]; ageSeconds: number }

async function referencePrice(mint: string): Promise<Reference> {
  const response = await fetch(`${HUB}/v1/stocks/markets/${mint}`, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`the gate answered ${response.status}; no reference, no launch`);
  const market = await response.json() as { consensus?: { reference?: { price: number; sources: string[]; age_seconds: number } } };
  const reference = market.consensus?.reference;
  if (!reference) throw new Error("the gate has no fresh reference price; a curve anchored to a guess is not anchored");
  return { price: reference.price, sources: reference.sources, ageSeconds: reference.age_seconds };
}

async function main() {
  const devnetState = JSON.parse(readFileSync(DEVNET_STATE, "utf8"));
  const state = mainnet ? (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { cluster: "mainnet-beta" }) : devnetState;

  // A launch that was started and not finished keeps the price it was planned
  // on. Re-reading the market would build a different curve around the config
  // that is already on chain.
  const pendingBefore = !state[SLOT] && existsSync(PENDING)
    ? JSON.parse(readFileSync(PENDING, "utf8")) as { reference: Reference }
    : undefined;
  // The share's price is the same whichever cluster the curve lives on; the hub
  // serves it for the devnet instrument that borrows AAPL's reference.
  const reference = pendingBefore?.reference ?? await referencePrice(devnetState.stockMint);
  const plan = planStockLaunch({ referenceUsd: reference.price, bandBps: arg("band", 300), raiseUsdc: arg("raise", DEFAULT_RAISE) });

  console.log(`${cluster}${rehearsal ? " (rehearsing mainnet's parameters)" : ""}: ${TOKEN.name} [${TOKEN.symbol}]`);
  console.log(`reference  $${reference.price.toFixed(2)} from ${reference.sources.join(" + ")}${pendingBefore ? ", kept from the run that started this launch" : `, ${reference.ageSeconds}s old`}\n`);
  for (const line of plan.explanation) console.log(`  ${line}`);
  console.log("\n  depth by price:");
  for (const segment of plan.segments) {
    console.log(`    up to $${segment.upToUsd.toFixed(2)}  ${"#".repeat(Math.round(segment.relativeDepth * 40))}`);
  }
  if (planOnly) return;

  const conn = new Connection(RPC, "confirmed");
  const payer = loadKeypair(PAYER);
  const dbc = new DynamicBondingCurveClient(conn, "confirmed");
  const quoteMint = new PublicKey(mainnet ? MAINNET_USDC : devnetState.usdcMint);
  const costs: Record<string, number> = {};
  const signatures: Record<string, string> = {};

  /** Send one SDK transaction and record the fee payer's balance change: fee plus rent. */
  const spend = async (label: string, tx: Transaction, signers: Keypair[]) => {
    const before = await conn.getBalance(payer.publicKey);
    // Mainnet drops what does not bid. A few thousand lamports is the
    // difference between landing and a blockhash expiring unanswered.
    const instructions = mainnet
      ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ...tx.instructions]
      : tx.instructions;
    signatures[label] = await send(conn, instructions, [payer, ...signers]);
    costs[label] = before - await conn.getBalance(payer.publicKey);
    console.log(`  ${label.padEnd(14)} ${SOL(costs[label])} SOL   ${explorer(signatures[label])}`);
  };

  let dbcState = state[SLOT] as { config: string; pool: string; baseMint: string } | undefined;
  if (!dbcState) {
    // The two new accounts' keys, written down before anything is sent.
    const pending = existsSync(PENDING)
      ? JSON.parse(readFileSync(PENDING, "utf8")) as { config: number[]; baseMint: number[]; reference: Reference; costs: Record<string, number>; signatures: Record<string, string> }
      : { config: [...Keypair.generate().secretKey], baseMint: [...Keypair.generate().secretKey], reference, costs: {}, signatures: {} };
    const remember = () => writeFileSync(PENDING, JSON.stringify({ ...pending, costs: { ...pending.costs, ...costs }, signatures: { ...pending.signatures, ...signatures } }));
    remember();
    const config = Keypair.fromSecretKey(Uint8Array.from(pending.config));
    const baseMint = Keypair.fromSecretKey(Uint8Array.from(pending.baseMint));
    const poolAddress = deriveDbcPoolAddress(quoteMint, baseMint.publicKey, config.publicKey);

    const balance = await conn.getBalance(payer.publicKey);
    console.log(`\npayer ${payer.publicKey.toBase58()} holds ${SOL(balance)} SOL`);
    const configThere = Boolean(await conn.getAccountInfo(config.publicKey));
    if (!configThere && balance < 32_000_000) throw new Error("a launch takes about 0.0266 SOL; the payer needs at least 0.032 to be safe");

    console.log("launching:");
    try {
      if (configThere) {
        console.log("  create_config  already on chain, from an earlier run");
      } else {
        await spend("create_config", await dbc.partner.createConfig({
          ...plan.config,
          config: config.publicKey,
          feeClaimer: payer.publicKey,
          leftoverReceiver: payer.publicKey,
          quoteMint,
          payer: payer.publicKey,
        }), [config]);
        remember();
      }
      if (await conn.getAccountInfo(poolAddress)) {
        console.log("  create_pool    already on chain, from an earlier run");
      } else {
        await spend("create_pool", await dbc.creator.createPool({
          name: TOKEN.name,
          symbol: TOKEN.symbol,
          uri: TOKEN.uri,
          payer: payer.publicKey,
          poolCreator: payer.publicKey,
          config: config.publicKey,
          baseMint: baseMint.publicKey,
        }), [baseMint]);
        remember();
      }
    } catch (error) {
      if (error instanceof UnresolvedSubmission) {
        console.error(`\nno answer from the network for ${error.signature}. Nothing is lost: run the same command again and it carries on from the chain.`);
      }
      throw error;
    }
    Object.assign(costs, { ...pending.costs, ...costs });
    Object.assign(signatures, { ...pending.signatures, ...signatures });
    dbcState = { config: config.publicKey.toBase58(), pool: poolAddress.toBase58(), baseMint: baseMint.publicKey.toBase58() };
    // Written the moment it exists. What was paid for must not depend on the
    // rest of this script running.
    const launch = (costs.create_config ?? 0) + (costs.create_pool ?? 0);
    state[SLOT] = {
      program: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
      ...dbcState,
      quoteMint: quoteMint.toBase58(),
      token: TOKEN,
      launched_at: new Date().toISOString(),
      anchored_to: { price_usd: reference.price, sources: reference.sources },
      plan: {
        band_bps: plan.input.bandBps,
        opening_price_usd: plan.openingPriceUsd,
        graduation_price_usd: plan.graduationPriceUsd,
        graduation_usdc: plan.graduationUsdc,
        total_supply: plan.totalSupply,
        starting_fee_bps: plan.input.startingFeeBps,
        ending_fee_bps: plan.input.endingFeeBps,
      },
      cost_lamports: { create_config: costs.create_config, create_pool: costs.create_pool, total: launch },
      setup: { create_config: signatures.create_config, create_pool: signatures.create_pool },
    };
    writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
    console.log(`\nlaunch cost     ${SOL(launch)} SOL${mainnet ? "" : ", which is what the same launch costs on mainnet"}`);
  } else {
    console.log(`\nreusing pool ${dbcState.pool}`);
  }

  const pool = new PublicKey(dbcState.pool);
  // A virtual pool decodes as `{ poolState: { ... } }`. The fields read here are
  // named, because the SDK's generated account types do not resolve cleanly.
  type PoolAccount = { poolState: { sqrtPrice: BN; config: PublicKey; isMigrated: number } };
  const readPool = async () => {
    const virtualPool = (await dbc.state.getPool(pool)) as unknown as PoolAccount | null;
    if (!virtualPool) throw new Error("the pool is not there");
    return {
      virtualPool,
      priceUsd: Number(getPriceFromSqrtPrice(virtualPool.poolState.sqrtPrice, TokenDecimal.SIX, TokenDecimal.SIX).toString()),
      progress: await dbc.state.getPoolQuoteTokenCurveProgress(pool),
    };
  };
  const before = await readPool();
  console.log(`pool price     $${before.priceUsd.toFixed(4)} (${premiumBps(before.priceUsd, reference.price)} bps from the reference), ${(before.progress * 100).toFixed(3)}% to graduation`);

  // Devnet's USDC is a test mint this key can print. Mainnet's is money, and
  // none is spent here: the launch is the whole of what this script does there.
  if (asMainnet) return;

  // One small buy, the way anyone would make it, to see the curve move.
  const usdc = await getOrCreateAssociatedTokenAccount(conn, payer, quoteMint, payer.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
  if (usdc.amount < 25_000_000n) await mintTo(conn, payer, quoteMint, usdc.address, payer, 1_000_000_000n, [], undefined, TOKEN_PROGRAM_ID);
  const poolConfig = await dbc.state.getPoolConfig(before.virtualPool.poolState.config);
  if (!poolConfig) throw new Error("the pool's config is not there");
  const amountIn = new BN(25_000_000);
  const quote = dbc.pool.swapQuote({
    virtualPool: before.virtualPool as never,
    config: poolConfig,
    swapBaseForQuote: false,
    amountIn,
    slippageBps: 50,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint: await dbcCurrentPoint(conn, poolConfig.activationType),
  });
  console.log("\nbuying 25 USDC:");
  await spend("first_buy", await dbc.pool.swap({
    owner: payer.publicKey,
    pool,
    amountIn,
    minimumAmountOut: quote.minimumAmountOut,
    swapBaseForQuote: false,
    referralTokenAccount: null,
  }), []);
  const after = await readPool();
  console.log(`  pool price     $${after.priceUsd.toFixed(4)} (${premiumBps(after.priceUsd, reference.price)} bps from the reference)`);
  console.log(`  to graduation  ${(after.progress * 100).toFixed(3)}%`);

  state[SLOT] = { ...state[SLOT], last_buy: { at: new Date().toISOString(), signature: signatures.first_buy, price_after_usd: after.priceUsd } };
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
}

main().catch((error) => {
  const logs = (error as { logs?: string[] }).logs;
  console.error(String((error as Error).message ?? error).replace(/api-key=[^&\s"]+/g, "api-key=***"));
  if (logs) console.error(logs.slice(-12).join("\n"));
  process.exit(1);
});
