/**
 * The governor buying the graduated curve's token on Meteora DAMM v2, on devnet.
 *
 *   npx ts-node solana/scripts/damm-governed.ts              # one governed buy of 2 USDC
 *   npx ts-node solana/scripts/damm-governed.ts --usdc 3
 *   npx ts-node solana/scripts/damm-governed.ts --refusals   # two trades the program must refuse
 *
 * The anchored curve graduated (solana/scripts/dbc-graduate.ts): it stopped
 * filling and its liquidity became a DAMM v2 pool. Nothing about the governor
 * changed. Its venues are an allowlist of programs that only the owner edits, so
 * the owner allows DAMM v2 once, and the same instrument, the same position
 * account and the same caps carry on, with the program measuring the vault and
 * the position either side of DAMM v2's swap exactly as it did for DBC's. No
 * program upgrade: the router is whatever program the owner allowed.
 *
 * `--refusals` sends the same two trades that must not settle as the curve's
 * script: one over the per-trade cap, which never reaches the venue, and one
 * where DAMM v2 is told to accept anything and the governor to expect twice what
 * the pool pays. DAMM v2's swap succeeds; the governor reverts it.
 */
import * as dotenv from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, type AccountMeta } from "@solana/web3.js";
import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CpAmm, derivePoolAuthority, getPriceFromSqrtPrice } from "@meteora-ag/cp-amm-sdk";
import {
  approveRouter,
  executeTrade,
  expectRefusal,
  fetchGovernor,
  governorPda,
  id32,
  routerPda,
  send,
  TxFailure,
  vaultAuthorityPda,
} from "../client";

dotenv.config();

const RPC = process.env.SOLANA_DEVNET_RPC_URL;
if (!RPC) throw new Error("SOLANA_DEVNET_RPC_URL is required");
const WSL_HOME = process.env.WSL_HOME ?? "//wsl.localhost/Ubuntu-24.04/home/divijn";
const DEPLOYER = process.env.DEVNET_DEPLOYER_KEYPAIR ?? `${WSL_HOME}/.config/solana/id.json`;
const KEYS = process.env.DEVNET_KEYS_DIR ?? `${WSL_HOME}/quaestor-target/devnet`;
const STATE = join(__dirname, "..", "..", "deployments", "solana-devnet.json");

const usdcArg = process.argv.indexOf("--usdc");
const USDC_IN = BigInt(Math.round(Number(usdcArg > 0 ? process.argv[usdcArg + 1] : 2) * 1e6));
const refusals = process.argv.includes("--refusals");
const SLIPPAGE_BPS = 50;
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const loadKeypair = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const units = (amount: bigint) => Number(amount) / 1e6;

async function main() {
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const graduation = state.dbc?.graduation;
  if (!graduation?.damm_pool) throw new Error("the curve has not graduated: run solana/scripts/dbc-graduate.ts first");
  if (!state.dbc.governed?.position) throw new Error("no position account: run solana/scripts/dbc-governed.ts once first");
  const conn = new Connection(RPC as string, "confirmed");
  const owner = loadKeypair(DEPLOYER);
  const operator = loadKeypair(`${KEYS}/operator.json`);
  if (owner.publicKey.toBase58() !== state.owner) throw new Error("the deployer key is not this governor's owner");

  const amm = new CpAmm(conn);
  const program = amm._program;
  const dammProgram = program.programId;
  const pool = new PublicKey(graduation.damm_pool);
  const baseMint = new PublicKey(state.dbc.baseMint);
  const quoteMint = new PublicKey(state.dbc.quoteMint ?? state.usdcMint);
  const vault = new PublicKey(state.vault);
  const position = new PublicKey(state.dbc.governed.position);
  const [governor] = governorPda(owner.publicKey);
  const [vaultAuthority] = vaultAuthorityPda(governor);

  // ---- the owner's part, once: allow DAMM v2 as a venue. The instrument and
  // the position account are the curve's; graduation changes neither.
  const setup: Record<string, string> = { ...graduation.governed?.setup };
  if (!(await conn.getAccountInfo(routerPda(governor, dammProgram)[0]))) {
    setup.approve_router = await send(conn, [approveRouter(owner.publicKey, dammProgram, "meteora-damm-v2")], [owner]);
    console.log(`owner allowed DAMM v2 as a venue   ${explorer(setup.approve_router)}`);
  }
  graduation.governed = { ...graduation.governed, setup };
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);

  // ---- the pool, and a quote from its own state
  const poolState = await amm.fetchPoolState(pool);
  if (!poolState.tokenAMint.equals(baseMint) || !poolState.tokenBMint.equals(quoteMint)) throw new Error("this DAMM v2 pool does not pair the curve's token with USDC");
  const slot = await conn.getSlot("confirmed");
  const blockTime = (await conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  const quoteFor = (amountIn: bigint) => amm.getQuote({
    inAmount: new BN(amountIn.toString()),
    inputTokenMint: quoteMint,
    slippage: SLIPPAGE_BPS,
    poolState,
    currentTime: blockTime,
    currentSlot: slot,
    tokenADecimal: 6,
    tokenBDecimal: 6,
  });
  const priceOf = (sqrtPrice: BN) => Number(getPriceFromSqrtPrice(sqrtPrice, 6, 6).toString());

  /** One governed trade; `venueFloor` is what DAMM v2 is told to insist on, `floor` what the governor is. */
  const attempt = async (label: string, amountIn: bigint, venueFloor: bigint, floor: bigint): Promise<string> => {
    const swap = await program.methods
      .swap({ amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(venueFloor.toString()) })
      .accountsPartial({
        poolAuthority: derivePoolAuthority(),
        pool,
        inputTokenAccount: vault,
        outputTokenAccount: position,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        payer: vaultAuthority,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
      } as never)
      .instruction();
    // The governor adds the PDA's signature when it calls DAMM v2, and no other.
    const remaining: AccountMeta[] = swap.keys.map((key) => (key.pubkey.equals(vaultAuthority) ? { ...key, isSigner: false } : key));
    const intent = `damm-${label}-${Date.now()}`;
    return send(conn, [executeTrade({
      operator: operator.publicKey,
      payer: owner.publicKey,
      governorOwner: owner.publicKey,
      vault,
      instrumentMint: baseMint,
      stockAccount: position,
      routerProgram: dammProgram,
      intentId: id32(intent),
      decisionHash: id32(`decision:${intent}`),
      decisionRecordHash: id32(`record:${intent}`),
      amountIn,
      minOutput: floor,
      swapData: swap.data,
      remaining,
    })], [owner, operator]);
  };
  const balances = async () => ({
    vault: (await getAccount(conn, vault, "confirmed", TOKEN_PROGRAM_ID)).amount,
    position: (await getAccount(conn, position, "confirmed", TOKEN_PROGRAM_ID)).amount,
  });

  if (refusals) {
    const before = await balances();
    const caps = await fetchGovernor(conn, governor);
    const tooMuch = caps.perTradeCap + 1_000_000n;
    const overCapFloor = BigInt(quoteFor(tooMuch).minSwapOutAmount.toString());
    const overCap = await expectRefusal("PerTradeCapExceeded", () => attempt("over-cap", tooMuch, overCapFloor, overCapFloor));
    console.log(`\nrefused  ${units(tooMuch)} USDC against a per-trade cap of ${units(caps.perTradeCap)}: PerTradeCapExceeded   ${explorer(overCap.signature)}`);

    const pays = BigInt(quoteFor(USDC_IN).swapOutAmount.toString());
    const shortfall = await expectRefusal("MinimumOutputNotMet", () => attempt("short", USDC_IN, 0n, pays * 2n));
    const reachedVenue = shortfall.logs.some((line) => line.includes(`Program ${dammProgram.toBase58()} success`));
    console.log(`refused  a floor of ${units(pays * 2n)} tokens where the pool pays ${units(pays)}: MinimumOutputNotMet   ${explorer(shortfall.signature)}`);
    console.log(`         DAMM v2 was told to accept anything and ${reachedVenue ? "its swap succeeded; the governor measured the position and reverted it" : "did not report success"}`);

    const after = await balances();
    if (after.vault !== before.vault || after.position !== before.position) throw new Error("a refused trade moved a balance");
    console.log(`         vault ${units(after.vault)} USDC and position ${units(after.position)} tokens, both unchanged`);
    graduation.governed.refusals = {
      at: new Date().toISOString(),
      per_trade_cap: { signature: overCap.signature, explorer: explorer(overCap.signature), usdc_in: tooMuch.toString() },
      minimum_output: { signature: shortfall.signature, explorer: explorer(shortfall.signature), floor: (pays * 2n).toString(), pool_pays: pays.toString(), venue_succeeded: reachedVenue },
    };
    writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
    return;
  }

  const quote = quoteFor(USDC_IN);
  const minOutput = BigInt(quote.minSwapOutAmount.toString());
  const priceBefore = priceOf(poolState.sqrtPrice);
  console.log(`\nquote: ${units(USDC_IN)} USDC for about ${units(BigInt(quote.swapOutAmount.toString()))} tokens, floor ${units(minOutput)}, pool at $${priceBefore.toFixed(4)}`);
  const before = await balances();
  let signature: string;
  try {
    signature = await attempt("buy", USDC_IN, minOutput, minOutput);
  } catch (error) {
    if (error instanceof TxFailure) {
      console.error(`reverted: ${error.anchorError ?? "runtime error"}   ${explorer(error.signature)}`);
      console.error(error.logs.slice(-14).join("\n"));
    }
    throw error;
  }
  const after = await balances();
  const poolAfter = await amm.fetchPoolState(pool);
  const spent = await fetchGovernor(conn, governor);
  console.log(`\nsettled through DAMM v2   ${explorer(signature)}`);
  console.log(`  vault      ${units(before.vault)} -> ${units(after.vault)} USDC`);
  console.log(`  position   ${units(before.position)} -> ${units(after.position)} tokens (floor was ${units(minOutput)})`);
  console.log(`  pool price $${priceBefore.toFixed(4)} -> $${priceOf(poolAfter.sqrtPrice).toFixed(4)}`);
  console.log(`  epoch      ${units(spent.spentInEpoch)} USDC spent of ${units(spent.epochCap)}`);

  graduation.governed.trades = [...(graduation.governed.trades ?? []), {
    at: new Date().toISOString(), signature, explorer: explorer(signature),
    usdc_in: USDC_IN.toString(), received: (after.position - before.position).toString(), min_output: minOutput.toString(),
  }];
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
}

main().catch((error) => {
  console.error(String((error as Error).message ?? error).replace(/api-key=[^&\s"]+/g, "api-key=***"));
  process.exit(1);
});
