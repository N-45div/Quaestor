import { expect } from "chai";
import { accountDiscriminator, base58, id32 } from "../solana/client";
import { INTENT_RECORD_SPACE } from "../stocks/solana-ledger";
import { decisionHash, SOLANA_USDC_MINT, StockGovernor, VERIFIED_XSTOCKS } from "../stocks";
import type { JupiterQuote, StockTradeIntent } from "../stocks/types";

describe("a hub that restarts takes the chain's word for what it forgot", () => {
  const nowSeconds = 1_700_000_000;
  const aapl = VERIFIED_XSTOCKS[0];
  const nvda = VERIFIED_XSTOCKS[1];
  const build = (caps = { perTrade: 5_000_000n, epoch: 25_000_000n }) => new StockGovernor({
    owner: "owner:test",
    operator: "operator:test",
    usdcMint: SOLANA_USDC_MINT,
    instruments: [...VERIFIED_XSTOCKS],
    policy: {
      perTradeCapUsdc: caps.perTrade,
      epochCapUsdc: caps.epoch,
      epochLengthSeconds: 86_400,
      approvedMints: new Set(VERIFIED_XSTOCKS.map((i) => i.mint)),
      approvedVenues: ["jupiter"],
    },
    now: () => nowSeconds,
  });
  const epoch = Math.floor(nowSeconds / 86_400);
  const chain = {
    vaultUsdc: 41_000_000n,
    epoch,
    spentInEpoch: 9_000_000n,
    suspended: false,
    holdings: [{ mint: aapl.mint, amount: 1_486_679n }, { mint: nvda.mint, amount: 0n }],
  };

  it("replaces the balance, the spend and the holdings it was started with", () => {
    const governor = build();
    governor.depositUsdc("owner:test", 100_000_000n);
    governor.adoptChainState(chain);

    const status = governor.status();
    expect(status.usdcBalance).to.equal(41_000_000n);
    expect(status.spent).to.equal(9_000_000n);
    // A position of zero is not a holding; it is an account that exists.
    expect(governor.portfolio().holdings).to.deep.equal([{ mint: aapl.mint, amount: 1_486_679n }]);
  });

  it("makes the preview agree with the chain about what is left", () => {
    const governor = build();
    governor.depositUsdc("owner:test", 100_000_000n);
    governor.adoptChainState(chain);
    const preview = governor.preview(intentFor(governor, 5_000_000n), quoteFor(5_000_000n));
    // 25 cap less 9 spent, so 5 fits and the vault has 41 behind it.
    expect(preview.allowed).to.equal(true);
    expect(preview.spentUsdc).to.equal(9_000_000n);
    expect(preview.availableVaultUsdc).to.equal(41_000_000n);
  });

  it("refuses what the chain's spend leaves no room for, where a forgetful hub would have allowed it", () => {
    const spentAlmostAll = { ...chain, spentInEpoch: 24_000_000n };
    const forgetful = build();
    forgetful.depositUsdc("owner:test", 100_000_000n);
    expect(forgetful.preview(intentFor(forgetful, 5_000_000n), quoteFor(5_000_000n)).allowed).to.equal(true);

    const adopted = build();
    adopted.depositUsdc("owner:test", 100_000_000n);
    adopted.adoptChainState(spentAlmostAll);
    const preview = adopted.preview(intentFor(adopted, 5_000_000n), quoteFor(5_000_000n));
    expect(preview.allowed).to.equal(false);
    expect(preview.refusalCode).to.equal("EPOCH_CAP_EXCEEDED");
  });

  it("carries no spend into an epoch the chain has already left", () => {
    // The governor account keeps the epoch it was last written in; the ledger
    // reports zero once the chain has moved on, and this is what that looks like.
    const governor = build();
    governor.adoptChainState({ ...chain, spentInEpoch: 0n });
    expect(governor.status().spent).to.equal(0n);
  });

  it("refuses for the true reason before it has read the chain, not for an empty vault", () => {
    const waiting = new StockGovernor({
      owner: "owner:test", operator: "operator:test", usdcMint: SOLANA_USDC_MINT,
      instruments: [...VERIFIED_XSTOCKS], awaitChainState: true,
      policy: {
        perTradeCapUsdc: 5_000_000n, epochCapUsdc: 25_000_000n, epochLengthSeconds: 86_400,
        approvedMints: new Set(VERIFIED_XSTOCKS.map((i) => i.mint)), approvedVenues: ["jupiter"],
      },
      now: () => nowSeconds,
    });
    const before = waiting.preview(intentFor(waiting, 2_000_000n), quoteFor(2_000_000n));
    // "Insufficient vault balance" would be a claim about the agent's money.
    // The truth is that this hub does not yet know what the balance is.
    expect(before.allowed).to.equal(false);
    expect(before.refusalCode).to.equal("CHAIN_STATE_UNAVAILABLE");
    expect(before.reason).to.contain("has not yet read");

    waiting.adoptChainState(chain);
    expect(waiting.preview(intentFor(waiting, 2_000_000n), quoteFor(2_000_000n)).allowed).to.equal(true);
  });

  it("does not make that excuse where nothing settles on chain", () => {
    // A simulation lane has no chain to read, so it must not refuse for one.
    const simulated = build();
    simulated.depositUsdc("owner:test", 100_000_000n);
    expect(simulated.preview(intentFor(simulated, 2_000_000n), quoteFor(2_000_000n)).allowed).to.equal(true);
  });

  it("follows the chain's cap back up, never past the one it was configured with", () => {
    const governor = build({ perTrade: 5_000_000n, epoch: 25_000_000n });
    // The owner tightens the chain, then loosens it again.
    governor.adoptChainState({ ...chain, perTradeCapUsdc: 1_000_000n, epochCapUsdc: 25_000_000n });
    expect(governor.preview(intentFor(governor, 2_000_000n), quoteFor(2_000_000n)).refusalCode).to.equal("PER_TRADE_CAP_EXCEEDED");

    const back = governor.adoptChainState({ ...chain, perTradeCapUsdc: 500_000_000n, epochCapUsdc: 900_000_000n });
    expect(back.capChanges).to.deep.equal(["per-trade cap 1000000 -> 5000000"]);
    // Back to the configured 5 USDC, and no further: a cap lowered once must
    // not be a cap lowered for good, and the chain's 500 is not this hub's.
    expect(governor.preview(intentFor(governor, 2_000_000n), quoteFor(2_000_000n)).allowed).to.equal(true);
    expect(governor.preview(intentFor(governor, 6_000_000n), quoteFor(6_000_000n)).refusalCode).to.equal("PER_TRADE_CAP_EXCEEDED");
  });

  it("takes a tighter cap from the chain and never a looser one", () => {
    const loose = build({ perTrade: 500_000_000n, epoch: 900_000_000n });
    const tightened = loose.adoptChainState({ ...chain, perTradeCapUsdc: 5_000_000n, epochCapUsdc: 25_000_000n });
    expect(tightened.capChanges).to.have.length(2);
    const preview = loose.preview(intentFor(loose, 6_000_000n), quoteFor(6_000_000n));
    expect(preview.allowed).to.equal(false);
    expect(preview.refusalCode).to.equal("PER_TRADE_CAP_EXCEEDED");

    // The hosted hub caps at 5 USDC where the chain allows 500. Adopting the
    // chain's would quietly widen what this deployment promises.
    const strict = build();
    expect(strict.adoptChainState({ ...chain, perTradeCapUsdc: 500_000_000n, epochCapUsdc: 900_000_000n }).capChanges).to.deep.equal([]);
    expect(strict.preview(intentFor(strict, 6_000_000n), quoteFor(6_000_000n)).refusalCode).to.equal("PER_TRADE_CAP_EXCEEDED");
  });

  it("adopts the chain's suspension", () => {
    const governor = build();
    governor.adoptChainState({ ...chain, suspended: true });
    expect(governor.status().suspended).to.equal(true);
  });

  it("will not overwrite the accounting while a trade is in flight", async () => {
    const governor = build();
    governor.depositUsdc("owner:test", 100_000_000n);
    const intent = intentFor(governor, 5_000_000n);
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => { release = resolve; });
    const executing = governor.execute(intent, quoteFor(5_000_000n), {
      execute: async () => {
        // A reservation is held exactly here, against an outcome nobody knows yet.
        expect(() => governor.adoptChainState(chain)).to.throw("in flight");
        await inFlight;
        return { txSignature: "sig", actualOutput: 2_000_000n, outcome: "settled" as const };
      },
    });
    release();
    await executing;
    // Once it has settled there is nothing to lose, so adoption is allowed again.
    expect(() => governor.adoptChainState(chain)).to.not.throw();
  });

  it("refuses a balance that was read before a trade settled, even though nothing is pending any more", async () => {
    const governor = build();
    governor.depositUsdc("owner:test", 100_000_000n);
    // The reconciler marks, then starts reading the chain...
    const readSince = governor.activityMark();
    // ...and while it reads, a trade reserves, executes and settles.
    await governor.execute(intentFor(governor, 5_000_000n), quoteFor(5_000_000n), {
      execute: async () => ({ txSignature: "sig", actualOutput: 10_000_000n, outcome: "settled" as const }),
    });
    expect(governor.status().usdcBalance).to.equal(95_000_000n);
    // The read now in hand saw the vault BEFORE the settlement. Nothing is
    // pending, so only the mark stands between it and undoing the trade here.
    expect(() => governor.adoptChainState({ ...chain, vaultUsdc: 100_000_000n, readSince })).to.throw("read while a trade was in flight");
    expect(governor.status().usdcBalance).to.equal(95_000_000n);
    // A fresh mark, a fresh read: adopted.
    expect(() => governor.adoptChainState({ ...chain, vaultUsdc: 95_000_000n, readSince: governor.activityMark() })).to.not.throw();
  });

  it("asks the chain for the accounts Anchor would have", () => {
    // These eight bytes are what an RPC memcmp filter matches on, and they are
    // the same constants the lean program carries, which the validator suite
    // has already proven against a real chain.
    expect([...accountDiscriminator("IntentRecord")]).to.deep.equal([176, 14, 151, 250, 200, 218, 41, 101]);
    expect([...accountDiscriminator("Governor")]).to.deep.equal([37, 136, 44, 80, 68, 85, 213, 178]);
    expect(base58(accountDiscriminator("IntentRecord"))).to.match(/^[1-9A-HJ-NP-Za-km-z]+$/);
    // 8 discriminator + governor + three hashes + four amounts + two timestamps + bump.
    expect(INTENT_RECORD_SPACE).to.equal(185);
  });

  it("finds a trade by the id the agent used, without the chain ever seeing that id", () => {
    // The program stores sha256 of the intent id, so a lookup is a hash, and
    // the id itself never leaves the hub.
    expect(id32("order-42")).to.deep.equal(id32("order-42"));
    expect(id32("order-42").equals(id32("order-43"))).to.equal(false);
    expect(id32("order-42")).to.have.length(32);
  });

  function quoteFor(amount: bigint): JupiterQuote {
    return {
      quoteId: `quote-${amount}`,
      venue: "jupiter",
      inputMint: SOLANA_USDC_MINT,
      outputMint: aapl.mint,
      inAmount: amount,
      outAmount: amount * 2n,
      minimumOutput: amount * 2n,
      route: "jupiter / test",
      expiresAt: nowSeconds + 60,
    };
  }

  function intentFor(governor: StockGovernor, amount: bigint): StockTradeIntent {
    const base = {
      intentId: `intent-${amount}-${governor.status().epoch}`,
      agentId: "agent",
      operator: "operator:test",
      instrumentMint: aapl.mint,
      inputMint: SOLANA_USDC_MINT,
      amountInUsdc: amount,
      minOutput: amount * 2n,
      quoteId: `quote-${amount}`,
      quoteExpiresAt: nowSeconds + 60,
      intentExpiresAt: nowSeconds + 60,
      decisionRecordHash: `0x${"11".repeat(32)}`,
    };
    return { ...base, decisionHash: decisionHash(base) };
  }
});

describe("listing settled trades is a scan, so it is asked for sparingly", () => {
  const { SolanaChainLedger } = require("../stocks/solana-ledger") as typeof import("../stocks/solana-ledger");
  const { Keypair, PublicKey } = require("@solana/web3.js") as typeof import("@solana/web3.js");

  /** A connection that counts how often the program's accounts are scanned. */
  const countingConnection = () => {
    const calls = { scans: 0 };
    return {
      calls,
      connection: {
        getProgramAccounts: async () => {
          calls.scans += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return [];
        },
      } as never,
    };
  };

  const ledgerOver = (connection: never, tradesCacheMs?: number) => new SolanaChainLedger({
    connection,
    governorOwner: Keypair.generate().publicKey,
    vault: Keypair.generate().publicKey,
    positions: new Map(),
    tradesCacheMs,
  });

  it("serves a burst of callers from one scan, and one scan only", async () => {
    const { calls, connection } = countingConnection();
    const ledger = ledgerOver(connection);
    await Promise.all(Array.from({ length: 10 }, () => ledger.trades(50)));
    // The route needs no key. Ten callers must not be ten scans of the program.
    expect(calls.scans).to.equal(1);
  });

  it("asks again once the answer is old enough to be worth re-reading", async () => {
    const { calls, connection } = countingConnection();
    const ledger = ledgerOver(connection, 1);
    await ledger.trades(50);
    await new Promise((resolve) => setTimeout(resolve, 8));
    await ledger.trades(50);
    expect(calls.scans).to.equal(2);
  });

  it("does not remember a scan that failed", async () => {
    let attempt = 0;
    const connection = {
      getProgramAccounts: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("rpc down");
        return [];
      },
    } as never;
    const ledger = ledgerOver(connection);
    await ledger.trades(50).then(() => expect.fail("should have thrown"), (error: Error) => expect(error.message).to.equal("rpc down"));
    expect(await ledger.trades(50)).to.deep.equal([]);
    expect(attempt).to.equal(2);
  });
});
