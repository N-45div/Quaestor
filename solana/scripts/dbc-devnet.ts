/**
 * Launch a reference-anchored Meteora DBC pool on devnet, and write down what
 * every step cost.
 *
 *   npx ts-node solana/scripts/dbc-devnet.ts              # plan, launch, one small buy
 *   npx ts-node solana/scripts/dbc-devnet.ts --plan       # print the plan and stop
 *   npx ts-node solana/scripts/dbc-devnet.ts --band 500 --raise 20000
 *
 * The reference price is not typed in. It is read from the hub's price gate,
 * which takes it from sources that have nothing to do with this pool; if the
 * gate has no fresh price the script stops, because a curve anchored to a guess
 * is not anchored.
 *
 * Rent is the same on every cluster, so the lamports recorded here are what the
 * same launch would cost on mainnet. They go, with the addresses, into
 * deployments/solana-devnet.json under `dbc`. Re-running reuses the pool.
 */
import * as dotenv from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  DynamicBondingCurveClient,
  TokenDecimal,
  deriveDbcPoolAddress,
  getCurrentPoint,
  getPriceFromSqrtPrice,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { send } from "../client";
import { planStockLaunch, premiumBps } from "../../stocks/dbc-launch";

dotenv.config();

const RPC = process.env.SOLANA_DEVNET_RPC_URL;
if (!RPC) throw new Error("SOLANA_DEVNET_RPC_URL is required");
const WSL_HOME = process.env.WSL_HOME ?? "//wsl.localhost/Ubuntu-24.04/home/divijn";
const DEPLOYER = process.env.DEVNET_DEPLOYER_KEYPAIR ?? `${WSL_HOME}/.config/solana/id.json`;
const STATE = join(__dirname, "..", "..", "deployments", "solana-devnet.json");
const HUB = process.env.STOCKS_API_URL_PUBLIC ?? "https://quaestor-stocks.onrender.com";
/** What the token says about itself. Served from the repository so it cannot drift from it. */
const METADATA_URI = "https://gitlab.com/ndivij2004/quaestor/-/raw/main/solana/dbc/metadata.json";

const arg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? Number(process.argv[at + 1]) : fallback;
};
const planOnly = process.argv.includes("--plan");
const SOL = (lamports: number) => (lamports / 1e9).toFixed(6);
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const loadKeypair = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));

async function referencePrice(mint: string): Promise<{ price: number; sources: string[]; ageSeconds: number }> {
  const response = await fetch(`${HUB}/v1/stocks/markets/${mint}`, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`the gate answered ${response.status}; no reference, no launch`);
  const market = await response.json() as { consensus?: { reference?: { price: number; sources: string[]; age_seconds: number } } };
  const reference = market.consensus?.reference;
  if (!reference) throw new Error("the gate has no fresh reference price; a curve anchored to a guess is not anchored");
  return { price: reference.price, sources: reference.sources, ageSeconds: reference.age_seconds };
}

async function main() {
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const reference = await referencePrice(state.stockMint);
  const plan = planStockLaunch({ referenceUsd: reference.price, bandBps: arg("band", 300), raiseUsdc: arg("raise", 50_000) });

  console.log(`reference  $${reference.price.toFixed(2)} from ${reference.sources.join(" + ")}, ${reference.ageSeconds}s old\n`);
  for (const line of plan.explanation) console.log(`  ${line}`);
  console.log("\n  depth by price:");
  for (const segment of plan.segments) {
    console.log(`    up to $${segment.upToUsd.toFixed(2)}  ${"#".repeat(Math.round(segment.relativeDepth * 40))}`);
  }
  if (planOnly) return;

  const conn = new Connection(RPC as string, "confirmed");
  const deployer = loadKeypair(DEPLOYER);
  const dbc = new DynamicBondingCurveClient(conn, "confirmed");
  const quoteMint = new PublicKey(state.usdcMint);
  const costs: Record<string, number> = {};
  const signatures: Record<string, string> = {};

  /** Send one SDK transaction and record the fee payer's balance change: fee plus rent. */
  const spend = async (label: string, tx: Transaction, signers: Keypair[]) => {
    const before = await conn.getBalance(deployer.publicKey);
    signatures[label] = await send(conn, tx.instructions, [deployer, ...signers]);
    costs[label] = before - await conn.getBalance(deployer.publicKey);
    console.log(`  ${label.padEnd(14)} ${SOL(costs[label])} SOL   ${explorer(signatures[label])}`);
  };

  let dbcState = state.dbc as { config: string; pool: string; baseMint: string } | undefined;
  if (!dbcState) {
    console.log("\nlaunching:");
    const config = Keypair.generate();
    const baseMint = Keypair.generate();
    await spend("create_config", await dbc.partner.createConfig({
      ...plan.config,
      config: config.publicKey,
      feeClaimer: deployer.publicKey,
      leftoverReceiver: deployer.publicKey,
      quoteMint,
      payer: deployer.publicKey,
    }), [config]);
    await spend("create_pool", await dbc.creator.createPool({
      name: "Quaestor AAPL curve (demo)",
      symbol: "qAAPLdemo",
      uri: METADATA_URI,
      payer: deployer.publicKey,
      poolCreator: deployer.publicKey,
      config: config.publicKey,
      baseMint: baseMint.publicKey,
    }), [baseMint]);
    dbcState = {
      config: config.publicKey.toBase58(),
      pool: deriveDbcPoolAddress(quoteMint, baseMint.publicKey, config.publicKey).toBase58(),
      baseMint: baseMint.publicKey.toBase58(),
    };
  } else {
    console.log(`\nreusing pool ${dbcState.pool}`);
  }

  const pool = new PublicKey(dbcState.pool);
  // The SDK's account types are derived from its IDL through Anchor's generics,
  // which do not resolve under this repo's Anchor version; the decoded account
  // does carry these fields, and they are the only ones read here.
  type PoolAccount = { sqrtPrice: BN; config: PublicKey; isMigrated: number };
  const readPool = async () => {
    const virtualPool = (await dbc.state.getPool(pool)) as unknown as PoolAccount | null;
    if (!virtualPool) throw new Error("the pool is not there");
    return {
      virtualPool,
      priceUsd: Number(getPriceFromSqrtPrice(virtualPool.sqrtPrice, TokenDecimal.SIX, TokenDecimal.SIX).toString()),
      progress: await dbc.state.getPoolQuoteTokenCurveProgress(pool),
    };
  };

  // One small buy, the way anyone would make it, to see the curve move.
  const usdc = await getOrCreateAssociatedTokenAccount(conn, deployer, quoteMint, deployer.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
  if (usdc.amount < 25_000_000n) await mintTo(conn, deployer, quoteMint, usdc.address, deployer, 1_000_000_000n, [], undefined, TOKEN_PROGRAM_ID);
  const before = await readPool();
  const poolConfig = await dbc.state.getPoolConfig(before.virtualPool.config);
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
    currentPoint: await getCurrentPoint(conn, poolConfig.activationType),
  });
  console.log(`\nbuying 25 USDC at $${before.priceUsd.toFixed(4)} (${premiumBps(before.priceUsd, reference.price)} bps from the reference):`);
  await spend("first_buy", await dbc.pool.swap({
    owner: deployer.publicKey,
    pool,
    amountIn,
    minimumAmountOut: quote.minimumAmountOut,
    swapBaseForQuote: false,
    referralTokenAccount: null,
  }), []);
  const after = await readPool();
  console.log(`  pool price     $${after.priceUsd.toFixed(4)} (${premiumBps(after.priceUsd, reference.price)} bps from the reference)`);
  console.log(`  to graduation  ${(after.progress * 100).toFixed(3)}%`);

  const launch = (costs.create_config ?? 0) + (costs.create_pool ?? 0);
  if (launch > 0) console.log(`\nlaunch cost     ${SOL(launch)} SOL, which is what the same launch costs on mainnet`);

  state.dbc = {
    ...(state.dbc ?? {}),
    program: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
    ...dbcState,
    quoteMint: state.usdcMint,
    metadata: METADATA_URI,
    ...(launch > 0 ? {
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
    } : {}),
  };
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
}

main().catch((error) => {
  const logs = (error as { logs?: string[] }).logs;
  console.error(String((error as Error).message ?? error).replace(/api-key=[^&\s"]+/g, "api-key=***"));
  if (logs) console.error(logs.slice(-12).join("\n"));
  process.exit(1);
});
