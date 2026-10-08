/**
 * Graduate the anchored DBC curve into Meteora DAMM v2, on devnet.
 *
 *   npx ts-node solana/scripts/dbc-graduate.ts            # fill what is left, then migrate
 *   npx ts-node solana/scripts/dbc-graduate.ts --check    # say where the curve stands and stop
 *
 * A curve is a launch, not a market. Once it has taken in its threshold it stops
 * filling, and its liquidity moves into a DAMM v2 pool at the curve's last price.
 * A route pinned to the curve breaks at that moment. The governor's does not: its
 * venues are an owner's allowlist of programs, so the same instrument keeps
 * trading once the owner allows DAMM v2 (solana/scripts/damm-governed.ts).
 *
 * Nobody trades devnet, so this script is the market: it buys what is left on
 * the curve with devnet's test USDC, which this key can print, using DBC's
 * partial-fill swap so it takes exactly what the threshold still needs. Then it
 * calls DBC's own migration, which anyone may call once a curve is complete.
 * Both steps are recorded in deployments/solana-devnet.json, and a re-run carries
 * on from whichever is missing.
 */
import * as dotenv from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  SwapMode,
  TokenDecimal,
  createDammV2Program,
  deriveDammV2PoolAddress,
  getPriceFromSqrtPrice,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { send } from "../client";

dotenv.config();

const RPC = process.env.SOLANA_DEVNET_RPC_URL;
if (!RPC) throw new Error("SOLANA_DEVNET_RPC_URL is required");
const WSL_HOME = process.env.WSL_HOME ?? "//wsl.localhost/Ubuntu-24.04/home/divijn";
const DEPLOYER = process.env.DEVNET_DEPLOYER_KEYPAIR ?? `${WSL_HOME}/.config/solana/id.json`;
const STATE = join(__dirname, "..", "..", "deployments", "solana-devnet.json");
const checkOnly = process.argv.includes("--check");
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const loadKeypair = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const usdc = (units: BN | bigint) => (Number(units.toString()) / 1e6).toFixed(2);

type VirtualPool = { poolState: { sqrtPrice: BN; config: PublicKey; baseMint: PublicKey; quoteReserve: BN; isMigrated: number } };

async function main() {
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  if (!state.dbc) throw new Error("no DBC pool recorded: run solana/scripts/dbc-devnet.ts first");
  const conn = new Connection(RPC as string, "confirmed");
  const payer = loadKeypair(DEPLOYER);
  const dbc = new DynamicBondingCurveClient(conn, "confirmed");
  const pool = new PublicKey(state.dbc.pool);
  const quoteMint = new PublicKey(state.dbc.quoteMint ?? state.usdcMint);

  const read = async () => {
    const virtualPool = (await dbc.state.getPool(pool)) as unknown as VirtualPool | null;
    if (!virtualPool) throw new Error("the pool is not there");
    const config = await dbc.state.getPoolConfig(virtualPool.poolState.config);
    if (!config) throw new Error("the pool's config is not there");
    const threshold = new BN(config.migrationQuoteThreshold.toString());
    return {
      virtualPool,
      config,
      threshold,
      raised: virtualPool.poolState.quoteReserve,
      complete: virtualPool.poolState.quoteReserve.gte(threshold),
      migrated: virtualPool.poolState.isMigrated !== 0,
      priceUsd: Number(getPriceFromSqrtPrice(virtualPool.poolState.sqrtPrice, TokenDecimal.SIX, TokenDecimal.SIX).toString()),
    };
  };

  let curve = await read();
  console.log(`curve ${pool.toBase58()}: ${usdc(curve.raised)} of ${usdc(curve.threshold)} USDC raised, at $${curve.priceUsd.toFixed(4)}, ${curve.migrated ? "migrated" : curve.complete ? "complete, not yet migrated" : "still filling"}`);
  if (checkOnly) return;
  const graduation: Record<string, unknown> = { ...state.dbc.graduation };

  // ---- 1. fill what is left
  if (!curve.complete) {
    const remaining = curve.threshold.sub(curve.raised);
    // The fee is taken on top of what reaches the curve; partial fill returns whatever is not needed.
    const amountIn = remaining.muln(103).divn(100);
    const account = await getOrCreateAssociatedTokenAccount(conn, payer, quoteMint, payer.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
    if (account.amount < BigInt(amountIn.toString())) {
      await mintTo(conn, payer, quoteMint, account.address, payer, BigInt(amountIn.toString()) - account.amount, [], undefined, TOKEN_PROGRAM_ID);
    }
    console.log(`\nbuying the rest of the curve: ${usdc(remaining)} USDC still needed, offering ${usdc(amountIn)} with partial fill`);
    const tx = await dbc.pool.swap2({
      owner: payer.publicKey,
      pool,
      swapBaseForQuote: false,
      referralTokenAccount: null,
      swapMode: SwapMode.PartialFill,
      amountIn,
      minimumAmountOut: new BN(0),
    });
    const before = (await getOrCreateAssociatedTokenAccount(conn, payer, quoteMint, payer.publicKey)).amount;
    const signature = await send(conn, tx.instructions, [payer]);
    const after = (await getOrCreateAssociatedTokenAccount(conn, payer, quoteMint, payer.publicKey)).amount;
    graduation.buyout = { at: new Date().toISOString(), signature, explorer: explorer(signature), usdc_spent: (before - after).toString() };
    console.log(`  filled: ${usdc(before - after)} USDC   ${explorer(signature)}`);
    curve = await read();
    console.log(`  curve now ${usdc(curve.raised)} of ${usdc(curve.threshold)} USDC, at $${curve.priceUsd.toFixed(4)}, ${curve.complete ? "complete" : "NOT complete"}`);
    state.dbc.graduation = graduation;
    writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
    if (!curve.complete) throw new Error("the curve did not complete; run again");
  }

  // ---- 2. migrate into DAMM v2
  const feeOption = Number((curve.config as unknown as { migrationFeeOption: number }).migrationFeeOption);
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[feeOption];
  if (!dammConfig) throw new Error(`no DAMM v2 config for migration fee option ${feeOption}`);
  const dammPool = deriveDammV2PoolAddress(dammConfig, curve.virtualPool.poolState.baseMint, quoteMint);
  if (!curve.migrated) {
    console.log(`\nmigrating into DAMM v2 (config ${dammConfig.toBase58()}, option ${feeOption}):`);
    const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await dbc.migration.migrateToDammV2({ payer: payer.publicKey, pool, dammConfig });
    const signature = await send(conn, transaction.instructions, [payer, firstPositionNftKeypair, secondPositionNftKeypair]);
    graduation.migration = {
      at: new Date().toISOString(), signature, explorer: explorer(signature),
      first_position_nft: firstPositionNftKeypair.publicKey.toBase58(), second_position_nft: secondPositionNftKeypair.publicKey.toBase58(),
    };
    console.log(`  migrated   ${explorer(signature)}`);
  } else {
    console.log("\nalready migrated");
  }

  // ---- 3. what it graduated into
  const damm = createDammV2Program(conn) as unknown as { account: { pool: { fetch: (key: PublicKey) => Promise<{ sqrtPrice: BN; liquidity: BN; tokenAMint: PublicKey; tokenBMint: PublicKey }> } } };
  const dammState = await damm.account.pool.fetch(dammPool);
  const dammPrice = Number(getPriceFromSqrtPrice(dammState.sqrtPrice, TokenDecimal.SIX, TokenDecimal.SIX).toString());
  console.log(`\nDAMM v2 pool ${dammPool.toBase58()}`);
  console.log(`  token A ${dammState.tokenAMint.toBase58()} (the curve's token), token B ${dammState.tokenBMint.toBase58()} (USDC)`);
  console.log(`  price $${dammPrice.toFixed(4)}; the curve closed at $${curve.priceUsd.toFixed(4)}`);
  state.dbc.graduation = { ...graduation, damm_program: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", damm_config: dammConfig.toBase58(), damm_pool: dammPool.toBase58(), opening_price_usd: dammPrice, curve_closing_price_usd: curve.priceUsd };
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
}

main().catch((error) => {
  const logs = (error as { logs?: string[] }).logs;
  console.error(String((error as Error).message ?? error).replace(/api-key=[^&\s"]+/g, "api-key=***"));
  if (logs) console.error(logs.slice(-14).join("\n"));
  process.exit(1);
});
