/**
 * The governor, run against a real validator.
 *
 * Every assertion here is about something the TypeScript layer in `stocks/`
 * cannot prove. That layer reads a quote and decides whether to allow a trade;
 * this one lets the trade happen and then checks what the token accounts say.
 * The two tests that matter most give the router a route that lies — one that
 * underdelivers, one that overspends — and require the chain to throw the whole
 * transaction away rather than record the shortfall after the money moved.
 *
 *   wsl bash solana/tests/validator.sh     (in one terminal)
 *   npm run stocks:solana:test             (in another)
 */
import { strict as assert } from "node:assert";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  createAccount,
  createMint,
  getAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  airdrop,
  approveInstrument,
  approveRouter,
  depositUsdc,
  discriminator,
  executeTrade,
  expectFailure,
  expectRefusal,
  fetchApprovedRouter,
  fetchGovernor,
  fetchIntentRecord,
  governorPda,
  id32,
  initializeGovernor,
  intentPda,
  positionAuthorityPda,
  revokeRouter,
  ROUTER_STUB_PROGRAM_ID,
  routerPda,
  send,
  setPolicy,
  setSuspended,
  STOCKS_PROGRAM_ID,
  stubSwapAccounts,
  stubSwapAndSweepAccounts,
  stubSwapAndSweepData,
  stubSwapData,
  stubSweepData,
  u64,
  vaultAuthorityPda,
} from "../client";

const RPC = process.env.SOLANA_RPC ?? "http://127.0.0.1:8899";

/** USDC is six decimals; the xStocks mints this trades against are eight. */
const USDC = (n: number): bigint => BigInt(Math.round(n * 1e6));
const SHARES = (n: number): bigint => BigInt(Math.round(n * 1e8));

const DAY = 86_400n;

interface World {
  owner: Keypair;
  operator: Keypair;
  poolAuthority: Keypair;
  usdcMint: PublicKey;
  stockMint: PublicKey;
  governor: PublicKey;
  vaultAuthority: PublicKey;
  vault: PublicKey;
  stockAccount: PublicKey;
  poolInput: PublicKey;
  poolOutput: PublicKey;
  /** Who owns the position held for a given instrument. */
  positionOwner: (mint: PublicKey) => PublicKey;
}

interface WorldOptions {
  epochCap?: bigint;
  perTradeCap?: bigint;
  funding?: bigint;
  /** Skip approving the stock mint, to test an instrument the owner never allowed. */
  approve?: boolean;
  /** Skip approving the venue, to test a router the owner never allowed. */
  approveRouter?: boolean;
}

/**
 * A complete, isolated deployment: its own owner, so its own governor PDA.
 *
 * Tests get one each rather than sharing. Several of them change policy or
 * suspend the agent, and a suite where test 9 only passes because test 3 ran
 * first is not testing the program, it is testing the ordering.
 */
async function makeWorld(conn: Connection, opts: WorldOptions = {}): Promise<World> {
  const epochCap = opts.epochCap ?? USDC(100_000);
  const perTradeCap = opts.perTradeCap ?? USDC(500);
  const funding = opts.funding ?? USDC(5_000);

  const owner = Keypair.generate();
  const operator = Keypair.generate();
  const poolAuthority = Keypair.generate();
  await Promise.all([
    airdrop(conn, owner.publicKey),
    airdrop(conn, operator.publicKey),
    airdrop(conn, poolAuthority.publicKey),
  ]);

  const usdcMint = await createMint(
    conn, owner, owner.publicKey, null, 6, Keypair.generate(), undefined, TOKEN_PROGRAM_ID,
  );
  // Token-2022, because that is what Backed issues the xStocks mints under. A
  // suite that stood the instrument up as classic SPL would not be exercising
  // the interface the program actually has to work through.
  const stockMint = await createMint(
    conn, owner, owner.publicKey, null, 8, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID,
  );

  const ownerUsdc = await createAccount(
    conn, owner, usdcMint, owner.publicKey, Keypair.generate(), undefined, TOKEN_PROGRAM_ID,
  );
  await mintTo(conn, owner, usdcMint, ownerUsdc, owner, funding, [], undefined, TOKEN_PROGRAM_ID);

  const poolInput = await createAccount(
    conn, owner, usdcMint, poolAuthority.publicKey, Keypair.generate(), undefined, TOKEN_PROGRAM_ID,
  );
  const poolOutput = await createAccount(
    conn, owner, stockMint, poolAuthority.publicKey, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID,
  );
  await mintTo(
    conn, owner, stockMint, poolOutput, owner, SHARES(1_000_000), [], undefined, TOKEN_2022_PROGRAM_ID,
  );

  const [governor] = governorPda(owner.publicKey);
  const [vaultAuthority] = vaultAuthorityPda(governor);
  const vaultKeypair = Keypair.generate();

  await send(conn, [
    initializeGovernor({
      owner: owner.publicKey,
      operator: operator.publicKey,
      usdcMint,
      vault: vaultKeypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      epochCap,
      perTradeCap,
      epochLength: DAY,
    }),
  ], [owner, vaultKeypair]);

  const positionOwner = (mint: PublicKey) => positionAuthorityPda(governor, mint)[0];
  const stockAccount = await createAccount(
    conn, owner, stockMint, positionOwner(stockMint), Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID,
  );

  const setup: TransactionInstruction[] = [];
  // The stub stands in for an aggregator: a local validator has no Jupiter or
  // Meteora to call, and it is the postconditions under test, not the DEX.
  if (opts.approveRouter !== false) {
    setup.push(approveRouter(owner.publicKey, ROUTER_STUB_PROGRAM_ID, "stub"));
  }
  if (opts.approve !== false) setup.push(approveInstrument(owner.publicKey, stockMint));
  setup.push(depositUsdc({
    depositor: owner.publicKey,
    governorOwner: owner.publicKey,
    vault: vaultKeypair.publicKey,
    depositorUsdc: ownerUsdc,
    usdcMint,
    tokenProgram: TOKEN_PROGRAM_ID,
    amount: funding,
  }));
  await send(conn, setup, [owner]);

  return {
    owner, operator, poolAuthority, usdcMint, stockMint,
    governor, vaultAuthority, vault: vaultKeypair.publicKey,
    stockAccount, poolInput, poolOutput, positionOwner,
  };
}

interface TradeOptions {
  label: string;
  amountIn: bigint;
  minOutput: bigint;
  /** What the route actually takes and gives — the whole point of the stub. */
  inputTaken?: bigint;
  outputGiven?: bigint;
  operator?: Keypair;
  routerProgram?: PublicKey;
  stockAccount?: PublicKey;
  approvedInstrument?: PublicKey;
  approvedRouter?: PublicKey;
  /** Call something other than the stub's `swap` with the same accounts. */
  swapData?: Buffer;
}

function tradeInstruction(w: World, o: TradeOptions): TransactionInstruction {
  const destination = o.stockAccount ?? w.stockAccount;
  return executeTrade({
    operator: (o.operator ?? w.operator).publicKey,
    payer: w.owner.publicKey,
    governorOwner: w.owner.publicKey,
    vault: w.vault,
    instrumentMint: w.stockMint,
    stockAccount: destination,
    routerProgram: o.routerProgram ?? ROUTER_STUB_PROGRAM_ID,
    intentId: id32(o.label),
    decisionHash: id32(`${o.label}:decision`),
    decisionRecordHash: id32(`${o.label}:record`),
    amountIn: o.amountIn,
    minOutput: o.minOutput,
    swapData: o.swapData ?? stubSwapData(o.inputTaken ?? o.amountIn, o.outputGiven ?? o.minOutput),
    approvedInstrument: o.approvedInstrument,
    approvedRouter: o.approvedRouter,
    remaining: stubSwapAccounts({
      vaultAuthority: w.vaultAuthority,
      poolAuthority: w.poolAuthority.publicKey,
      vault: w.vault,
      poolInput: w.poolInput,
      poolOutput: w.poolOutput,
      destination,
      inputMint: w.usdcMint,
      outputMint: w.stockMint,
      inputTokenProgram: TOKEN_PROGRAM_ID,
      outputTokenProgram: TOKEN_2022_PROGRAM_ID,
    }),
  });
}

const trade = (conn: Connection, w: World, o: TradeOptions): Promise<string> =>
  send(conn, [tradeInstruction(w, o)], [w.owner, o.operator ?? w.operator, w.poolAuthority]);

const balance = async (conn: Connection, account: PublicKey, programId: PublicKey): Promise<bigint> =>
  (await getAccount(conn, account, "confirmed", programId)).amount;

const usdcBalance = (conn: Connection, w: World): Promise<bigint> =>
  balance(conn, w.vault, TOKEN_PROGRAM_ID);

const stockBalance = (conn: Connection, w: World): Promise<bigint> =>
  balance(conn, w.stockAccount, TOKEN_2022_PROGRAM_ID);

describe("quaestor-stocks on-chain governor", function () {
  this.timeout(180_000);
  const conn = new Connection(RPC, "confirmed");

  before(async () => {
    const stocks = await conn.getAccountInfo(STOCKS_PROGRAM_ID);
    const router = await conn.getAccountInfo(ROUTER_STUB_PROGRAM_ID);
    assert.ok(
      stocks?.executable && router?.executable,
      `no validator at ${RPC} with both programs loaded — run: wsl bash solana/tests/validator.sh`,
    );
  });

  describe("balance postconditions", () => {
    it("settles a route that honours its floor, and records what it cost", async () => {
      const w = await makeWorld(conn);
      const before = await usdcBalance(conn, w);

      await trade(conn, w, {
        label: "happy",
        amountIn: USDC(100),
        minOutput: SHARES(0.4),
        outputGiven: SHARES(0.41),
      });

      assert.equal(await usdcBalance(conn, w), before - USDC(100));
      assert.equal(await stockBalance(conn, w), SHARES(0.41));

      const governor = await fetchGovernor(conn, w.governor);
      assert.equal(governor.spentInEpoch, USDC(100));

      const [record] = intentPda(w.governor, id32("happy"));
      const intent = await fetchIntentRecord(conn, record);
      assert.ok(intent, "a settled trade must leave an intent record");
      assert.equal(intent.amountAuthorized, USDC(100));
      assert.equal(intent.amountSpent, USDC(100));
      assert.equal(intent.minOutput, SHARES(0.4));
      assert.equal(intent.actualOutput, SHARES(0.41));
    });

    it("reverts a route that delivers under the intent minimum", async () => {
      const w = await makeWorld(conn);
      const before = await usdcBalance(conn, w);

      await expectRefusal("MinimumOutputNotMet", () =>
        trade(conn, w, {
          label: "short",
          amountIn: USDC(100),
          minOutput: SHARES(0.4),
          // One lamport of stock short. The off-chain governor cleared this
          // route because the quote said it would clear; only the account
          // balance can say whether it did.
          outputGiven: SHARES(0.4) - 1n,
        }));

      assert.equal(await usdcBalance(conn, w), before, "a refused trade must not cost the vault");
      assert.equal(await stockBalance(conn, w), 0n);
      assert.equal((await fetchGovernor(conn, w.governor)).spentInEpoch, 0n);
    });

    it("reverts a route that takes the money and delivers nothing", async () => {
      const w = await makeWorld(conn);
      const before = await usdcBalance(conn, w);

      await expectRefusal("MinimumOutputNotMet", () =>
        trade(conn, w, {
          label: "theft",
          amountIn: USDC(100),
          minOutput: SHARES(0.4),
          inputTaken: USDC(100),
          outputGiven: 0n,
        }));

      assert.equal(await usdcBalance(conn, w), before);
    });

    it("reverts a route that spends more input than it was authorised", async () => {
      const w = await makeWorld(conn);
      const before = await usdcBalance(conn, w);

      await expectRefusal("RouteOverspent", () =>
        trade(conn, w, {
          label: "overspend",
          amountIn: USDC(100),
          minOutput: SHARES(0.4),
          // A route is free to build an instruction that drains more than it
          // quoted. The authorisation is a ceiling on the vault, not on what
          // the route claimed it would do.
          inputTaken: USDC(140),
          outputGiven: SHARES(0.6),
        }));

      assert.equal(await usdcBalance(conn, w), before);
      assert.equal(await stockBalance(conn, w), 0n);
    });

    it("reverts a route that sweeps the shares the agent already held", async () => {
      const w = await makeWorld(conn);
      await trade(conn, w, { label: "held", amountIn: USDC(100), minOutput: SHARES(0.4) });
      const heldBefore = await stockBalance(conn, w);
      const usdcBefore = await usdcBalance(conn, w);

      // The position is owned by the per-instrument position authority, which
      // is never lent to the router, so the sweep is refused by the token
      // program before the governor's balance postcondition is even reached.
      // StockBalanceDecreased remains as a second, independent guard.
      await expectFailure(/owner does not match|custom program error: 0x4/, () =>
        trade(conn, w, {
          label: "sweep",
          amountIn: USDC(100),
          minOutput: SHARES(0.4),
          swapData: stubSweepData(SHARES(0.2)),
        }));

      assert.equal(await stockBalance(conn, w), heldBefore, "the position must survive");
      assert.equal(await usdcBalance(conn, w), usdcBefore);
    });

    it("cannot reach a position held for another instrument", async () => {
      const w = await makeWorld(conn);
      // The agent already holds a second instrument.
      const otherMint = await createMint(
        conn, w.owner, w.owner.publicKey, null, 8, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID,
      );
      await send(conn, [approveInstrument(w.owner.publicKey, otherMint)], [w.owner]);
      const otherPosition = await createAccount(
        conn, w.owner, otherMint, w.positionOwner(otherMint), Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID,
      );
      await mintTo(conn, w.owner, otherMint, otherPosition, w.owner, SHARES(5), [], undefined, TOKEN_2022_PROGRAM_ID);
      const otherPool = await createAccount(
        conn, w.owner, otherMint, w.poolAuthority.publicKey, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID,
      );
      const usdcBefore = await usdcBalance(conn, w);

      // Buys exactly what was authorised, delivers exactly the floor, and in
      // the same instruction sells off the other position. The vault and the
      // instrument being bought both move exactly as allowed, so no balance
      // check on them can see it.
      const attack = executeTrade({
        operator: w.operator.publicKey,
        payer: w.owner.publicKey,
        governorOwner: w.owner.publicKey,
        vault: w.vault,
        instrumentMint: w.stockMint,
        stockAccount: w.stockAccount,
        routerProgram: ROUTER_STUB_PROGRAM_ID,
        intentId: id32("cross-sweep"),
        decisionHash: id32("cross-sweep:decision"),
        decisionRecordHash: id32("cross-sweep:record"),
        amountIn: USDC(100),
        minOutput: SHARES(0.4),
        swapData: stubSwapAndSweepData(USDC(100), SHARES(0.4), SHARES(5)),
        remaining: stubSwapAndSweepAccounts({
          vaultAuthority: w.vaultAuthority,
          poolAuthority: w.poolAuthority.publicKey,
          vault: w.vault,
          poolInput: w.poolInput,
          poolOutput: w.poolOutput,
          destination: w.stockAccount,
          inputMint: w.usdcMint,
          outputMint: w.stockMint,
          inputTokenProgram: TOKEN_PROGRAM_ID,
          outputTokenProgram: TOKEN_2022_PROGRAM_ID,
          otherPosition,
          otherMint,
          otherPool,
        }),
      });

      // The borrowed signature does not own that position, so the token
      // program refuses the transfer and the whole transaction goes with it.
      await expectFailure(/owner does not match|custom program error: 0x4/, () =>
        send(conn, [attack], [w.owner, w.operator, w.poolAuthority]));
      assert.equal(await balance(conn, otherPosition, TOKEN_2022_PROGRAM_ID), SHARES(5), "the other position must survive");
      assert.equal(await usdcBalance(conn, w), usdcBefore);
    });

    it("charges the epoch what the route took, not what it was allowed to take", async () => {
      const w = await makeWorld(conn);
      const before = await usdcBalance(conn, w);

      await trade(conn, w, {
        label: "underspend",
        amountIn: USDC(100),
        minOutput: SHARES(0.4),
        inputTaken: USDC(60),
        outputGiven: SHARES(0.4),
      });

      assert.equal(await usdcBalance(conn, w), before - USDC(60));
      const governor = await fetchGovernor(conn, w.governor);
      assert.equal(governor.spentInEpoch, USDC(60), "budget it never used must not be consumed");

      const [record] = intentPda(w.governor, id32("underspend"));
      const intent = await fetchIntentRecord(conn, record);
      assert.equal(intent?.amountAuthorized, USDC(100));
      assert.equal(intent?.amountSpent, USDC(60));
    });
  });

  describe("policy", () => {
    it("refuses a second execution of the same intent id", async () => {
      const w = await makeWorld(conn);
      const once = { label: "replay", amountIn: USDC(100), minOutput: SHARES(0.4) };
      await trade(conn, w, once);

      // The guard is the record PDA existing, so the replay dies at account
      // creation — before the swap is ever composed.
      await expectFailure(/already in use/, () => trade(conn, w, once));

      assert.equal((await fetchGovernor(conn, w.governor)).spentInEpoch, USDC(100));
    });

    it("refuses to trade while suspended", async () => {
      const w = await makeWorld(conn);
      await send(conn, [setSuspended(w.owner.publicKey, true)], [w.owner]);

      await expectRefusal("Suspended", () =>
        trade(conn, w, { label: "suspended", amountIn: USDC(100), minOutput: SHARES(0.4) }));
    });

    it("refuses an instrument the owner never approved", async () => {
      const w = await makeWorld(conn, { approve: false });

      await expectRefusal("AccountNotInitialized", () =>
        trade(conn, w, { label: "unapproved", amountIn: USDC(100), minOutput: SHARES(0.4) }));
    });

    it("refuses a trade above the per-trade cap", async () => {
      const w = await makeWorld(conn, { perTradeCap: USDC(50) });

      await expectRefusal("PerTradeCapExceeded", () =>
        trade(conn, w, { label: "per-trade", amountIn: USDC(51), minOutput: SHARES(0.2) }));
    });

    it("refuses the trade that would breach the epoch cap", async () => {
      const w = await makeWorld(conn, { epochCap: USDC(150), perTradeCap: USDC(100) });

      await trade(conn, w, { label: "epoch-1", amountIn: USDC(100), minOutput: SHARES(0.4) });
      await expectRefusal("EpochCapExceeded", () =>
        trade(conn, w, { label: "epoch-2", amountIn: USDC(100), minOutput: SHARES(0.4) }));

      // The breaching trade left nothing behind: the budget still reads what
      // the one settled trade spent.
      assert.equal((await fetchGovernor(conn, w.governor)).spentInEpoch, USDC(100));
    });

    it("refuses a signer that is not the operator", async () => {
      const w = await makeWorld(conn);
      const impostor = Keypair.generate();
      await airdrop(conn, impostor.publicKey);

      await expectRefusal("OperatorRequired", () =>
        trade(conn, w, {
          label: "impostor",
          amountIn: USDC(100),
          minOutput: SHARES(0.4),
          operator: impostor,
        }));
    });

    it("refuses a venue the owner never allowed", async () => {
      const w = await makeWorld(conn);

      // No ApprovedRouter PDA exists for this program, so the trade dies on the
      // account that would have proved permission.
      await expectRefusal("AccountNotInitialized", () =>
        trade(conn, w, {
          label: "wrong-router",
          amountIn: USDC(100),
          minOutput: SHARES(0.4),
          routerProgram: TOKEN_PROGRAM_ID,
        }));
    });

    it("refuses a venue proof that belongs to a different program", async () => {
      const w = await makeWorld(conn);
      // Approve a second venue, then try to route through it while presenting
      // the *stub's* proof — the seeds are checked against the program named.
      await send(conn, [approveRouter(w.owner.publicKey, TOKEN_PROGRAM_ID, "decoy")], [w.owner]);
      const [stubProof] = routerPda(w.governor, ROUTER_STUB_PROGRAM_ID);

      await expectRefusal("ConstraintSeeds", () =>
        trade(conn, w, {
          label: "mismatched-proof",
          amountIn: USDC(100),
          minOutput: SHARES(0.4),
          routerProgram: TOKEN_PROGRAM_ID,
          approvedRouter: stubProof,
        }));
    });

    it("refuses a destination the vault authority does not own", async () => {
      const w = await makeWorld(conn);
      // Same mint, same approved instrument — but the shares would land in
      // someone else's account.
      const thief = Keypair.generate();
      const elsewhere = await createAccount(
        conn, w.owner, w.stockMint, thief.publicKey, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID,
      );

      await expectRefusal("WrongOutputOwner", () =>
        trade(conn, w, {
          label: "wrong-destination",
          amountIn: USDC(100),
          minOutput: SHARES(0.4),
          stockAccount: elsewhere,
        }));
    });

    it("will not let the operator raise its own cap", async () => {
      const w = await makeWorld(conn, { perTradeCap: USDC(50) });
      // The real governor account, signed by the operator. Its seeds come from
      // the owner, so the operator cannot make this address derive.
      const raise = new TransactionInstruction({
        programId: STOCKS_PROGRAM_ID,
        keys: [
          { pubkey: w.operator.publicKey, isSigner: true, isWritable: false },
          { pubkey: w.governor, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([discriminator("set_policy"), u64(USDC(1e6)), u64(USDC(1e6))]),
      });

      await expectRefusal("ConstraintSeeds", () => send(conn, [raise], [w.operator]));
      assert.equal((await fetchGovernor(conn, w.governor)).perTradeCap, USDC(50));
    });

    it("lets the owner change policy, and the next trade is measured against it", async () => {
      const w = await makeWorld(conn, { perTradeCap: USDC(50) });

      await expectRefusal("PerTradeCapExceeded", () =>
        trade(conn, w, { label: "before-raise", amountIn: USDC(100), minOutput: SHARES(0.4) }));

      await send(conn, [setPolicy(w.owner.publicKey, USDC(100_000), USDC(200))], [w.owner]);
      await trade(conn, w, { label: "after-raise", amountIn: USDC(100), minOutput: SHARES(0.4) });

      assert.equal((await fetchGovernor(conn, w.governor)).spentInEpoch, USDC(100));
    });
  });

  describe("venues", () => {
    it("holds several venues at once, each labelled on-chain", async () => {
      const w = await makeWorld(conn);
      // A second venue beside the stub. On mainnet these are Jupiter, Meteora
      // and whatever routes the best fill next quarter; here the address only
      // has to be distinct, because approving one never calls it.
      await send(conn, [approveRouter(w.owner.publicKey, TOKEN_PROGRAM_ID, "meteora")], [w.owner]);

      const [stub] = routerPda(w.governor, ROUTER_STUB_PROGRAM_ID);
      const [second] = routerPda(w.governor, TOKEN_PROGRAM_ID);
      assert.equal((await fetchApprovedRouter(conn, stub))?.label, "stub");
      assert.equal((await fetchApprovedRouter(conn, second))?.label, "meteora");

      // Holding two does not disturb routing through either.
      await trade(conn, w, { label: "two-venues", amountIn: USDC(100), minOutput: SHARES(0.4) });
      assert.equal((await fetchGovernor(conn, w.governor)).spentInEpoch, USDC(100));
    });

    it("stops routing through a venue the owner withdrew, and resumes when it returns", async () => {
      const w = await makeWorld(conn);
      await trade(conn, w, { label: "venue-before", amountIn: USDC(100), minOutput: SHARES(0.4) });

      await send(conn, [revokeRouter(w.owner.publicKey, ROUTER_STUB_PROGRAM_ID)], [w.owner]);
      await expectRefusal("AccountNotInitialized", () =>
        trade(conn, w, { label: "venue-during", amountIn: USDC(100), minOutput: SHARES(0.4) }));

      await send(conn, [approveRouter(w.owner.publicKey, ROUTER_STUB_PROGRAM_ID, "stub")], [w.owner]);
      await trade(conn, w, { label: "venue-after", amountIn: USDC(100), minOutput: SHARES(0.4) });

      assert.equal((await fetchGovernor(conn, w.governor)).spentInEpoch, USDC(200));
    });

    it("will not let the operator add a venue", async () => {
      const w = await makeWorld(conn);
      // Signed by the operator against its own derived governor, which does not
      // exist: choosing a venue is the operator's, widening the set is not.
      await expectRefusal("AccountNotInitialized", () =>
        send(conn, [approveRouter(w.operator.publicKey, TOKEN_PROGRAM_ID, "smuggled")], [w.operator]));
    });
  });
});
