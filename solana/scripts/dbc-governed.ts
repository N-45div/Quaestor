/**
 * The governor buying from the anchored DBC pool, on devnet.
 *
 *   npx ts-node solana/scripts/dbc-governed.ts              # one governed buy of 2 USDC
 *   npx ts-node solana/scripts/dbc-governed.ts --usdc 3
 *   npx ts-node solana/scripts/dbc-governed.ts --refusals   # two trades the program must refuse
 *
 * Until now the devnet venue was a stub whose pool side this process had to
 * sign. This is a real venue: Meteora's DBC program, called by the governor with
 * the vault's PDA as the payer and the instrument's own position account as the
 * destination. Nothing of ours signs for the pool.
 *
 * The owner does three things once, and only the owner can: allow the DBC
 * program as a venue, allow this mint as an instrument, and open the position
 * account that the per-instrument authority owns. After that the operator can
 * buy, inside the caps, and the program measures the vault and the position
 * either side of DBC's swap exactly as it does for any other route.
 *
 * `--refusals` sends two trades that must not settle. One is over the per-trade
 * cap and never reaches the venue. The other tells DBC it will accept anything
 * and tells the governor to expect twice what the curve pays: DBC's swap
 * succeeds, the governor measures what arrived, and the whole transaction
 * reverts. The venue being satisfied is not the test.
 */
import * as dotenv from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, SystemProgram, type AccountMeta } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  createInitializeAccount3Instruction,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  DynamicBondingCurveClient,
  TokenDecimal,
  deriveDbcEventAuthority,
  deriveDbcPoolAuthority,
  getCurrentPoint,
  getPriceFromSqrtPrice,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  approveInstrument,
  approveRouter,
  executeTrade,
  expectRefusal,
  fetchGovernor,
  governorPda,
  id32,
  instrumentPda,
  positionAuthorityPda,
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
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const loadKeypair = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const units = (amount: bigint) => Number(amount) / 1e6;

type PoolAccount = { poolState: { sqrtPrice: BN; config: PublicKey; baseVault: PublicKey; quoteVault: PublicKey } };

async function main() {
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  if (!state.dbc) throw new Error("no DBC pool recorded: run solana/scripts/dbc-devnet.ts first");
  const conn = new Connection(RPC as string, "confirmed");
  const owner = loadKeypair(DEPLOYER);
  const operator = loadKeypair(`${KEYS}/operator.json`);
  if (owner.publicKey.toBase58() !== state.owner) throw new Error("the deployer key is not this governor's owner");

  const dbc = new DynamicBondingCurveClient(conn, "confirmed");
  const program = dbc.state.getProgram();
  const dbcProgram = program.programId;
  const pool = new PublicKey(state.dbc.pool);
  const baseMint = new PublicKey(state.dbc.baseMint);
  const quoteMint = new PublicKey(state.usdcMint);
  const vault = new PublicKey(state.vault);
  const [governor] = governorPda(owner.publicKey);
  const [vaultAuthority] = vaultAuthorityPda(governor);
  const [positionAuthority] = positionAuthorityPda(governor, baseMint);

  // ---- the owner's part, once
  const setup: Record<string, string> = { ...state.dbc.governed?.setup };
  if (!(await conn.getAccountInfo(routerPda(governor, dbcProgram)[0]))) {
    setup.approve_router = await send(conn, [approveRouter(owner.publicKey, dbcProgram, "meteora-dbc")], [owner]);
    console.log(`owner allowed the DBC program as a venue   ${explorer(setup.approve_router)}`);
  }
  if (!(await conn.getAccountInfo(instrumentPda(governor, baseMint)[0]))) {
    setup.approve_instrument = await send(conn, [approveInstrument(owner.publicKey, baseMint)], [owner]);
    console.log(`owner allowed the curve's mint as an instrument   ${explorer(setup.approve_instrument)}`);
  }
  let position = state.dbc.governed?.position ? new PublicKey(state.dbc.governed.position) : null;
  if (!position) {
    // Owned by the per-instrument authority, which is never lent to a venue: a
    // route can deliver into it and cannot spend from it.
    const account = Keypair.generate();
    const rent = await conn.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
    setup.open_position = await send(conn, [
      SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: account.publicKey, lamports: rent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeAccount3Instruction(account.publicKey, baseMint, positionAuthority, TOKEN_PROGRAM_ID),
    ], [owner, account]);
    position = account.publicKey;
    console.log(`owner opened the position account   ${explorer(setup.open_position)}`);
  }
  const stockAccount = position;
  state.dbc.governed = { ...state.dbc.governed, position: stockAccount.toBase58(), position_authority: positionAuthority.toBase58(), setup };
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);

  // ---- the pool, and a quote from the curve itself
  const virtualPool = (await dbc.state.getPool(pool)) as unknown as PoolAccount | null;
  if (!virtualPool) throw new Error("the pool is not there");
  const config = await dbc.state.getPoolConfig(virtualPool.poolState.config);
  if (!config) throw new Error("the pool's config is not there");
  const currentPoint = await getCurrentPoint(conn, config.activationType);
  const quoteFor = (amountIn: bigint) => dbc.pool.swapQuote({
    virtualPool: virtualPool as never,
    config,
    swapBaseForQuote: false,
    amountIn: new BN(amountIn.toString()),
    slippageBps: 50,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
  });
  const priceOf = (account: PoolAccount) => Number(getPriceFromSqrtPrice(account.poolState.sqrtPrice, TokenDecimal.SIX, TokenDecimal.SIX).toString());

  /**
   * One governed trade. `venueFloor` is what DBC is told to insist on, `floor`
   * what the governor is; they are separate on purpose, so a test can make the
   * venue lenient and see which of the two actually refuses.
   */
  const attempt = async (label: string, amountIn: bigint, venueFloor: bigint, floor: bigint): Promise<string> => {
    const swap = await program.methods
      .swap({ amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(venueFloor.toString()) })
      .accountsPartial({
        poolAuthority: deriveDbcPoolAuthority(),
        config: virtualPool.poolState.config,
        pool,
        inputTokenAccount: vault,
        outputTokenAccount: stockAccount,
        baseVault: virtualPool.poolState.baseVault,
        quoteVault: virtualPool.poolState.quoteVault,
        baseMint,
        quoteMint,
        payer: vaultAuthority,
        tokenBaseProgram: TOKEN_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
        eventAuthority: deriveDbcEventAuthority(),
        program: dbcProgram,
      } as never)
      .instruction();
    // The outer transaction cannot carry the PDA's signature; the governor adds
    // it when it calls DBC, and adds no other.
    const remaining: AccountMeta[] = swap.keys.map((key) => (key.pubkey.equals(vaultAuthority) ? { ...key, isSigner: false } : key));
    const intent = `dbc-${label}-${Date.now()}`;
    return send(conn, [executeTrade({
      operator: operator.publicKey,
      payer: owner.publicKey,
      governorOwner: owner.publicKey,
      vault,
      instrumentMint: baseMint,
      stockAccount,
      routerProgram: dbcProgram,
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
    position: (await getAccount(conn, stockAccount, "confirmed", TOKEN_PROGRAM_ID)).amount,
  });

  if (refusals) {
    const before = await balances();
    const caps = await fetchGovernor(conn, governor);
    const tooMuch = caps.perTradeCap + 1_000_000n;
    // A real floor: the program refuses a trade with none before it looks at the cap.
    const overCapFloor = BigInt(quoteFor(tooMuch).minimumAmountOut.toString());
    const overCap = await expectRefusal("PerTradeCapExceeded", () => attempt("over-cap", tooMuch, overCapFloor, overCapFloor));
    console.log(`\nrefused  ${units(tooMuch)} USDC against a per-trade cap of ${units(caps.perTradeCap)}: PerTradeCapExceeded   ${explorer(overCap.signature)}`);

    const pays = BigInt(quoteFor(USDC_IN).outputAmount.toString());
    const shortfall = await expectRefusal("MinimumOutputNotMet", () => attempt("short", USDC_IN, 0n, pays * 2n));
    const reachedVenue = shortfall.logs.some((line) => line.includes(`Program ${dbcProgram.toBase58()} success`));
    console.log(`refused  a floor of ${units(pays * 2n)} tokens where the curve pays ${units(pays)}: MinimumOutputNotMet   ${explorer(shortfall.signature)}`);
    console.log(`         DBC was told to accept anything and ${reachedVenue ? "its swap succeeded; the governor measured the position and reverted it" : "did not report success"}`);

    const after = await balances();
    if (after.vault !== before.vault || after.position !== before.position) throw new Error("a refused trade moved a balance");
    console.log(`         vault ${units(after.vault)} USDC and position ${units(after.position)} tokens, both unchanged`);
    state.dbc.governed.refusals = {
      at: new Date().toISOString(),
      per_trade_cap: { signature: overCap.signature, explorer: explorer(overCap.signature), usdc_in: tooMuch.toString() },
      minimum_output: { signature: shortfall.signature, explorer: explorer(shortfall.signature), floor: (pays * 2n).toString(), curve_pays: pays.toString(), venue_succeeded: reachedVenue },
    };
    writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
    return;
  }

  const quote = quoteFor(USDC_IN);
  const minOutput = BigInt(quote.minimumAmountOut.toString());
  const priceBefore = priceOf(virtualPool);
  console.log(`\nquote: ${units(USDC_IN)} USDC for about ${units(BigInt(quote.outputAmount.toString()))} tokens, floor ${units(minOutput)}, pool at $${priceBefore.toFixed(4)}`);
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
  const poolAfter = (await dbc.state.getPool(pool)) as unknown as PoolAccount;
  const spent = await fetchGovernor(conn, governor);
  console.log(`\nsettled through DBC   ${explorer(signature)}`);
  console.log(`  vault      ${units(before.vault)} -> ${units(after.vault)} USDC`);
  console.log(`  position   ${units(before.position)} -> ${units(after.position)} tokens (floor was ${units(minOutput)})`);
  console.log(`  pool price $${priceBefore.toFixed(4)} -> $${priceOf(poolAfter).toFixed(4)}`);
  console.log(`  epoch      ${units(spent.spentInEpoch)} USDC spent of ${units(spent.epochCap)}`);

  state.dbc.governed.trades = [...(state.dbc.governed.trades ?? []), {
    at: new Date().toISOString(), signature, explorer: explorer(signature),
    usdc_in: USDC_IN.toString(), received: (after.position - before.position).toString(), min_output: minOutput.toString(),
  }];
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
}

main().catch((error) => {
  console.error(String((error as Error).message ?? error).replace(/api-key=[^&\s"]+/g, "api-key=***"));
  process.exit(1);
});
