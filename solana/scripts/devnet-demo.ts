/**
 * The governor on Solana devnet, end to end: one trade that settles and three
 * routes that lie and are reverted, each with a public signature.
 *
 *   npx ts-node solana/scripts/devnet-demo.ts
 *
 * Needs SOLANA_DEVNET_RPC_URL (the public devnet endpoint throttles too hard to
 * deploy or trade through) and the deployer keypair, which stays in WSL and is
 * read in place rather than copied. Operator and router keys are generated once
 * into the same directory, outside the repo.
 *
 * Devnet has no xStocks and no Jupiter liquidity for them, so the instrument is
 * a Token-2022 test mint and the venue is the stub router — which is the point:
 * the stub is how a route is made to lie on purpose. The refusals are real
 * transactions that land and revert, so their logs carry the governor's own
 * error names.
 *
 * Public addresses and signatures go to deployments/solana-devnet.json. Re-runs
 * reuse the same governor and mints and add new trades.
 */
import * as dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  createAccount,
  createMint,
  getAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  approveInstrument,
  approveRouter,
  depositUsdc,
  executeTrade,
  fetchGovernor,
  governorPda,
  id32,
  initializeGovernor,
  ROUTER_STUB_PROGRAM_ID,
  send,
  STOCKS_PROGRAM_ID,
  stubSwapAccounts,
  stubSwapData,
  stubSweepData,
  TxFailure,
  vaultAuthorityPda,
} from "../tests/client";

dotenv.config();

const RPC = process.env.SOLANA_DEVNET_RPC_URL;
if (!RPC) throw new Error("SOLANA_DEVNET_RPC_URL is required — the public devnet endpoint throttles deploys and trades");

const WSL_HOME = process.env.WSL_HOME ?? "//wsl.localhost/Ubuntu-24.04/home/divijn";
const DEPLOYER = process.env.DEVNET_DEPLOYER_KEYPAIR ?? `${WSL_HOME}/.config/solana/id.json`;
const KEYS = process.env.DEVNET_KEYS_DIR ?? `${WSL_HOME}/quaestor-target/devnet`;
const STATE = join(__dirname, "..", "..", "deployments", "solana-devnet.json");

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const SHARES = (n: number) => BigInt(Math.round(n * 1e8));
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const loadKeypair = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));

function keypairAt(name: string): Keypair {
  const path = `${KEYS}/${name}.json`;
  if (existsSync(path)) return loadKeypair(path);
  mkdirSync(KEYS, { recursive: true });
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify([...kp.secretKey]));
  return kp;
}

interface DevnetState {
  cluster: "devnet";
  programs: { quaestor_stocks: string; router_stub: string };
  owner: string;
  operator: string;
  governor: string;
  vaultAuthority: string;
  vault: string;
  usdcMint: string;
  stockMint: string;
  stockAccount: string;
  poolInput: string;
  poolOutput: string;
  poolAuthority: string;
  setup: Record<string, string>;
  trades: Array<{ label: string; at: string; outcome: string; signature: string; explorer: string; detail: string }>;
}

async function main(): Promise<void> {
  const conn = new Connection(RPC!, "confirmed");
  const owner = loadKeypair(DEPLOYER);
  const operator = keypairAt("operator");
  const poolAuthority = keypairAt("pool-authority");
  const [governor] = governorPda(owner.publicKey);
  const [vaultAuthority] = vaultAuthorityPda(governor);

  console.log(`owner    ${owner.publicKey.toBase58()}  (${(await conn.getBalance(owner.publicKey)) / 1e9} SOL)`);
  console.log(`governor ${governor.toBase58()}`);

  let state: DevnetState | undefined = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : undefined;
  const governorExists = (await conn.getAccountInfo(governor)) !== null;

  if (!governorExists || !state) {
    console.log("\n— setting up a fresh governor on devnet");
    const setup: Record<string, string> = {};

    // The pool authority signs the stub's side of each swap. It never pays
    // fees here, but a keypair with no lamports cannot sign a transfer that
    // creates anything, so give it a little.
    setup.fund_pool = await send(conn, [SystemProgram.transfer({
      fromPubkey: owner.publicKey, toPubkey: poolAuthority.publicKey, lamports: 20_000_000,
    })], [owner]);

    const usdcMint = await createMint(conn, owner, owner.publicKey, null, 6, Keypair.generate(), undefined, TOKEN_PROGRAM_ID);
    // Token-2022, as Backed issues the xStocks mints.
    const stockMint = await createMint(conn, owner, owner.publicKey, null, 8, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID);
    const ownerUsdc = await createAccount(conn, owner, usdcMint, owner.publicKey, Keypair.generate(), undefined, TOKEN_PROGRAM_ID);
    await mintTo(conn, owner, usdcMint, ownerUsdc, owner, USDC(1_000), [], undefined, TOKEN_PROGRAM_ID);
    const poolInput = await createAccount(conn, owner, usdcMint, poolAuthority.publicKey, Keypair.generate(), undefined, TOKEN_PROGRAM_ID);
    const poolOutput = await createAccount(conn, owner, stockMint, poolAuthority.publicKey, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID);
    await mintTo(conn, owner, stockMint, poolOutput, owner, SHARES(100_000), [], undefined, TOKEN_2022_PROGRAM_ID);

    const vault = Keypair.generate();
    setup.initialize_governor = await send(conn, [initializeGovernor({
      owner: owner.publicKey,
      operator: operator.publicKey,
      usdcMint,
      vault: vault.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      epochCap: USDC(10_000),
      perTradeCap: USDC(500),
      epochLength: 86_400n,
    })], [owner, vault]);

    const stockAccount = await createAccount(conn, owner, stockMint, vaultAuthority, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID);

    setup.approve_and_fund = await send(conn, [
      approveRouter(owner.publicKey, ROUTER_STUB_PROGRAM_ID, "stub"),
      approveInstrument(owner.publicKey, stockMint),
      depositUsdc({
        depositor: owner.publicKey,
        governorOwner: owner.publicKey,
        vault: vault.publicKey,
        depositorUsdc: ownerUsdc,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        amount: USDC(1_000),
      }),
    ], [owner]);

    state = {
      cluster: "devnet",
      programs: { quaestor_stocks: STOCKS_PROGRAM_ID.toBase58(), router_stub: ROUTER_STUB_PROGRAM_ID.toBase58() },
      owner: owner.publicKey.toBase58(),
      operator: operator.publicKey.toBase58(),
      governor: governor.toBase58(),
      vaultAuthority: vaultAuthority.toBase58(),
      vault: vault.publicKey.toBase58(),
      usdcMint: usdcMint.toBase58(),
      stockMint: stockMint.toBase58(),
      stockAccount: stockAccount.toBase58(),
      poolInput: poolInput.toBase58(),
      poolOutput: poolOutput.toBase58(),
      poolAuthority: poolAuthority.publicKey.toBase58(),
      setup,
      trades: [],
    };
    for (const [step, sig] of Object.entries(setup)) console.log(`  ${step.padEnd(20)} ${explorer(sig)}`);
  } else {
    console.log("\n— reusing the governor from deployments/solana-devnet.json");
  }

  const s = state!;
  const pk = (v: string) => new PublicKey(v);
  const run = Date.now().toString(36);

  const trade = async (label: string, opts: { amountIn: bigint; minOutput: bigint; swapData: Buffer }) => {
    const ix = executeTrade({
      operator: operator.publicKey,
      payer: owner.publicKey,
      governorOwner: owner.publicKey,
      vault: pk(s.vault),
      instrumentMint: pk(s.stockMint),
      stockAccount: pk(s.stockAccount),
      routerProgram: ROUTER_STUB_PROGRAM_ID,
      intentId: id32(`${label}:${run}`),
      decisionHash: id32(`${label}:${run}:decision`),
      decisionRecordHash: id32(`${label}:${run}:record`),
      amountIn: opts.amountIn,
      minOutput: opts.minOutput,
      swapData: opts.swapData,
      remaining: stubSwapAccounts({
        vaultAuthority: pk(s.vaultAuthority),
        poolAuthority: poolAuthority.publicKey,
        vault: pk(s.vault),
        poolInput: pk(s.poolInput),
        poolOutput: pk(s.poolOutput),
        destination: pk(s.stockAccount),
        inputMint: pk(s.usdcMint),
        outputMint: pk(s.stockMint),
        inputTokenProgram: TOKEN_PROGRAM_ID,
        outputTokenProgram: TOKEN_2022_PROGRAM_ID,
      }),
    });
    try {
      const sig = await send(conn, [ix], [owner, operator, poolAuthority]);
      return { outcome: "settled", signature: sig, detail: "postconditions held" };
    } catch (error) {
      if (!(error instanceof TxFailure)) throw error;
      // The transaction landed and reverted: its logs are the evidence.
      return { outcome: "reverted", signature: error.signature, detail: error.anchorError ?? "runtime error" };
    }
  };

  const vaultBefore = (await getAccount(conn, pk(s.vault), "confirmed", TOKEN_PROGRAM_ID)).amount;
  const cases: Array<[string, string, { amountIn: bigint; minOutput: bigint; swapData: Buffer }]> = [
    ["honest", "a route that honours its floor", { amountIn: USDC(100), minOutput: SHARES(0.4), swapData: stubSwapData(USDC(100), SHARES(0.41)) }],
    ["underdeliver", "one lamport under the floor", { amountIn: USDC(100), minOutput: SHARES(0.4), swapData: stubSwapData(USDC(100), SHARES(0.4) - 1n) }],
    ["overspend", "takes 140 USDC of an authorised 100", { amountIn: USDC(100), minOutput: SHARES(0.4), swapData: stubSwapData(USDC(140), SHARES(0.6)) }],
    ["sweep", "buys nothing and takes shares back out", { amountIn: USDC(100), minOutput: SHARES(0.4), swapData: stubSweepData(SHARES(0.2)) }],
  ];

  console.log("\n— trades");
  for (const [label, what, opts] of cases) {
    const r = await trade(label, opts);
    console.log(`  ${label.padEnd(12)} ${r.outcome.padEnd(9)} ${r.detail.padEnd(22)} ${what}`);
    console.log(`  ${"".padEnd(12)} ${explorer(r.signature)}`);
    s.trades.push({ label, at: new Date().toISOString(), ...r, explorer: explorer(r.signature) });
  }

  const vaultAfter = (await getAccount(conn, pk(s.vault), "confirmed", TOKEN_PROGRAM_ID)).amount;
  const shares = (await getAccount(conn, pk(s.stockAccount), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const g = await fetchGovernor(conn, pk(s.governor));
  console.log(`\nvault ${Number(vaultBefore) / 1e6} → ${Number(vaultAfter) / 1e6} USDC · shares held ${Number(shares) / 1e8} · epoch spend ${Number(g.spentInEpoch) / 1e6} USDC`);
  console.log(`(the three lying routes cost the vault nothing: only the honest trade moved money)`);

  // Guard the claim above rather than just printing it.
  const spent = vaultBefore - vaultAfter;
  if (spent !== USDC(100)) throw new Error(`expected exactly 100 USDC to leave the vault, saw ${Number(spent) / 1e6}`);

  mkdirSync(join(__dirname, "..", "..", "deployments"), { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n");
  console.log(`\nwrote ${STATE}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
