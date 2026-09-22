import { expect } from "chai";
import { Keypair, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { swapFrom, type DbcPoolState, type DbcTrade } from "../stocks/dbc-venue";
import { DbcCurveWatcher, curveView, type DbcWatchedPool, type LaunchedCurve } from "../stocks/dbc-watch";
import { mainnetRpcUrl } from "../services/stocks-mainnet-curve";

const key = () => Keypair.generate().publicKey.toBase58();

/** QANCHOR as launched on mainnet on 21 Sep. */
const QANCHOR: LaunchedCurve = {
  cluster: "mainnet",
  pool: "5cbDfFRGsAUUMGM5XJsKgkzZUJeLuD7H2QtkjkBXmz4N",
  baseMint: "2PMn7R1veKBxybb4AsS983h81mTT9Us5jNhhsuDdn2LL",
  symbol: "QANCHOR",
  anchoredToUsd: 334.875,
  bandBps: 300,
  openingPriceUsd: 324.82875,
  graduationPriceUsd: 344.92125,
  graduationUsdc: 5096.191463,
};
const OPENS_AT = 1_789_978_113;

/** A pool that can be traded, moved or taken offline on demand, and counts what it is asked. */
class FakeWatchedPool implements DbcWatchedPool {
  state_: DbcPoolState = {
    graduated: false, priceUsd: 324.828802, progress: 6.3e-7,
    tradingFees: 11_596_466n, unclaimedFees: 11_596_466n, protocolFees: 2_430_990n, opensAt: OPENS_AT,
  };
  history: DbcTrade[] = [];
  down = false;
  reads = 0;
  tradeReads: Array<{ cursor: string | undefined; limit: number }> = [];

  async state() {
    this.reads += 1;
    if (this.down) throw new Error("rpc down");
    return { ...this.state_ };
  }

  async tradesSince(cursor: string | undefined, limit: number) {
    this.tradeReads.push({ cursor, limit });
    const from = cursor === undefined ? 0 : this.history.findIndex((trade) => trade.signature === cursor) + 1;
    const trades = this.history.slice(from, from + limit);
    return { trades, cursor: trades[trades.length - 1]?.signature ?? cursor, more: from + limit < this.history.length };
  }
}

const trade = (at: number, side: "buy" | "sell", usdc: bigint): DbcTrade => ({ signature: key(), at, side, usdc, tokens: 1n });

/** The launch's first five minutes: nine snipers in the first 26 seconds, then three sells that take it all back out. */
function launchMinutes(): DbcTrade[] {
  return [
    ...Array.from({ length: 9 }, (_, i) => trade(OPENS_AT + 24 + (i < 5 ? 0 : 2), "buy", 85_000_000n)),
    trade(OPENS_AT + 106, "buy", 144_870_939n),
    trade(OPENS_AT + 304, "buy", 1_116_725n),
    trade(OPENS_AT + 304, "sell", 87_893_103n),
    trade(OPENS_AT + 304, "sell", 658_190_228n),
    trade(OPENS_AT + 314, "sell", 141_638_471n),
  ];
}

describe("watching a curve this hub does not trade", () => {
  it("reads the pool and its trades once a pass, and serves any number of requests from that", async () => {
    const pool = new FakeWatchedPool();
    pool.history = launchMinutes();
    const watcher = new DbcCurveWatcher({ curve: QANCHOR, pool, now: () => OPENS_AT + 86_400 });
    await watcher.tick();
    for (let i = 0; i < 50; i += 1) watcher.monitor(340.1);
    expect(pool.reads).to.equal(1);
    expect(pool.tradeReads).to.have.length(1);

    const view = watcher.monitor(340.1);
    expect(view.cluster).to.equal("mainnet");
    expect(view.symbol).to.equal("QANCHOR");
    expect(view.health).to.equal("at-opening");
    expect(view.summary).to.contain("still at its opening price of $324.83").and.to.contain("waiting for buyers");
    expect(view.fees).to.deep.equal({ earned_usdc: 11.596466, unclaimed_usdc: 11.596466, protocol_usdc: 2.43099 });
    expect(view.activity).to.include({ trades: 14, buys: 11, sells: 3, in_first_minute: 9 });
    expect(view.activity?.opened_at).to.equal("2026-09-21T08:08:33.000Z");
    expect(view.activity?.first_trade_at).to.equal("2026-09-21T08:08:57.000Z");
    expect(view.activity?.last_trade_at).to.equal("2026-09-21T08:13:47.000Z");
    expect(view.activity?.sold_usdc).to.equal(887.721802);
  });

  it("does not ask for transactions again until the pool has moved, and then not more often than allowed", async () => {
    const pool = new FakeWatchedPool();
    pool.history = launchMinutes();
    let clock = OPENS_AT + 86_400;
    const watcher = new DbcCurveWatcher({ curve: QANCHOR, pool, activityEveryMs: 1_800_000, now: () => clock });
    await watcher.tick();
    clock += 300;
    await watcher.tick();
    expect(pool.reads).to.equal(2);
    expect(pool.tradeReads).to.have.length(1);

    // A new buy moves the fee counters; inside the half hour it waits.
    const cursor = pool.history[pool.history.length - 1].signature;
    pool.history.push(trade(clock, "buy", 10_000_000n));
    pool.state_ = { ...pool.state_, tradingFees: pool.state_.tradingFees + 20_000n, progress: 0.00196 };
    clock += 300;
    await watcher.tick();
    expect(pool.tradeReads).to.have.length(1);
    clock += 1_800;
    await watcher.tick();
    expect(pool.tradeReads).to.have.length(2);
    expect(pool.tradeReads[1].cursor).to.equal(cursor);
    expect(watcher.monitor(340.1).activity).to.include({ trades: 15, buys: 12 });
  });

  it("works through a long history over several passes, without waiting for the pool to move", async () => {
    const pool = new FakeWatchedPool();
    pool.history = launchMinutes();
    const watcher = new DbcCurveWatcher({ curve: QANCHOR, pool, transactionsPerPass: 5, now: () => OPENS_AT + 86_400 });
    await watcher.tick();
    expect(watcher.monitor(340.1).activity?.trades).to.equal(5);
    await watcher.tick();
    await watcher.tick();
    expect(watcher.monitor(340.1).activity?.trades).to.equal(14);
    await watcher.tick();
    expect(pool.tradeReads).to.have.length(3);
  });

  it("claims nothing before the first read, and keeps the last one when a read fails", async () => {
    const pool = new FakeWatchedPool();
    const errors: unknown[] = [];
    let clock = OPENS_AT + 86_400;
    const watcher = new DbcCurveWatcher({ curve: QANCHOR, pool, onError: (error) => errors.push(error), now: () => clock });
    const before = watcher.monitor(340.1);
    expect(before.health).to.equal(undefined);
    expect(before.activity).to.equal(undefined);
    expect(before.summary).to.contain("not been read");

    await watcher.tick();
    pool.down = true;
    clock += 300;
    await watcher.tick();
    expect(errors).to.have.length(1);
    const after = watcher.monitor(340.1);
    expect(after.observed_at).to.equal(new Date((OPENS_AT + 86_400) * 1000).toISOString());
    expect(after.health).to.equal("at-opening");
  });

  it("reports a graduated curve as graduated, with no price", async () => {
    const pool = new FakeWatchedPool();
    pool.state_ = { ...pool.state_, graduated: true };
    const watcher = new DbcCurveWatcher({ curve: QANCHOR, pool });
    await watcher.tick();
    const view = watcher.monitor(340.1);
    expect(view.health).to.equal("graduated");
    expect(view.pool_price_usd).to.equal(undefined);
  });

  it("does not overlap passes when the RPC is slow", async () => {
    const pool = new FakeWatchedPool();
    const watcher = new DbcCurveWatcher({ curve: QANCHOR, pool });
    await Promise.all([watcher.tick(), watcher.tick(), watcher.tick()]);
    expect(pool.reads).to.equal(1);
  });

  it("serves the devnet curve through the same view, marked as devnet", () => {
    const view = curveView({ ...QANCHOR, cluster: "devnet" }, { observedAt: 1_000, graduated: false, priceUsd: 324.9, progress: 0.001 }, 340.1);
    expect(view.cluster).to.equal("devnet");
    expect(view.fees).to.equal(undefined);
    expect(view.raised_usdc).to.equal(5.1);
  });
});

describe("reading a swap off a transaction", () => {
  const vaults = { base: key(), quote: key() };
  const tx = (balances: Array<[string, string, string]>): ParsedTransactionWithMeta => {
    const accounts = balances.map(([account]) => account);
    return {
      slot: 1,
      blockTime: 1,
      transaction: { signatures: [], message: { accountKeys: accounts.map((pubkey) => ({ pubkey: new PublicKey(pubkey), signer: false, writable: true })), instructions: [], recentBlockhash: "" } },
      meta: {
        fee: 5_000, err: null, preBalances: [], postBalances: [],
        preTokenBalances: balances.map(([, pre], accountIndex) => ({ accountIndex, mint: key(), uiTokenAmount: { amount: pre, decimals: 6, uiAmount: null } })),
        postTokenBalances: balances.map(([, , post], accountIndex) => ({ accountIndex, mint: key(), uiTokenAmount: { amount: post, decimals: 6, uiAmount: null } })),
      },
    } as unknown as ParsedTransactionWithMeta;
  };

  it("is a buy when tokens leave the curve and USDC enters it, whoever routed it", () => {
    expect(swapFrom(tx([[key(), "90", "0"], [vaults.base, "31000000", "30729803"], [vaults.quote, "0", "89702506"]]), vaults))
      .to.deep.equal({ side: "buy", usdc: 89_702_506n, tokens: 270_197n });
  });

  it("is a sell the other way round", () => {
    expect(swapFrom(tx([[vaults.quote, "658193443", "3215"], [vaults.base, "28991299", "31000000"]]), vaults))
      .to.deep.equal({ side: "sell", usdc: 658_190_228n, tokens: 2_008_701n });
  });

  it("is not a trade when only one vault moves: a creation or a fee claim", () => {
    expect(swapFrom(tx([[vaults.base, "0", "31000000"]]), vaults)).to.equal(undefined);
    expect(swapFrom(tx([[vaults.quote, "14030671", "2434205"]]), vaults)).to.equal(undefined);
  });
});

describe("the mainnet RPC", () => {
  it("is the one named for it first", () => {
    expect(mainnetRpcUrl({ SOLANA_MAINNET_RPC_URL: "https://rpc.example/m", SOLANA_DEVNET_RPC_URL: "https://devnet.helius-rpc.com/?api-key=k" })).to.equal("https://rpc.example/m");
  });

  it("follows a keyed devnet URL to the same provider's mainnet host, key and all", () => {
    expect(mainnetRpcUrl({ SOLANA_DEVNET_RPC_URL: "https://devnet.helius-rpc.com/?api-key=k" })).to.equal("https://mainnet.helius-rpc.com/?api-key=k");
  });

  it("does not guess at any other devnet URL, and falls back to the public endpoint", () => {
    expect(mainnetRpcUrl({ SOLANA_DEVNET_RPC_URL: "https://api.devnet.solana.com" })).to.equal("https://api.mainnet-beta.solana.com");
    expect(mainnetRpcUrl({ SOLANA_DEVNET_RPC_URL: "not a url" })).to.equal("https://api.mainnet-beta.solana.com");
    expect(mainnetRpcUrl({})).to.equal("https://api.mainnet-beta.solana.com");
  });
});
