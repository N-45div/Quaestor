import { expect } from "chai";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  PriceTape,
  SOLANA_USDC_MINT,
  StockGovernor,
  StockPlatform,
  TapeMarketGuard,
  VERIFIED_XSTOCKS,
  type PriceSide,
  type StockInstrument,
} from "../stocks";
import { mountIntel } from "../services/intel";

/** Wednesday 10:00 in New York — a regular session, so the tight premium band applies. */
const NOW = Math.floor(Date.parse("2026-09-16T14:00:00Z") / 1000);
const PROXY_KEY = "proxy-key-for-tests-0123456789abcdef";
const AAPLX = VERIFIED_XSTOCKS.find((i) => i.underlyingSymbol === "AAPL") as StockInstrument;
/** Raw base units per UI share, as Jupiter publishes it for AAPLx. */
const MULTIPLIER = 1.0032690125398187;

/** A devnet-style deployment: it trades one test mint and merely *watches* the real ones. */
const TEST_MINT: StockInstrument = {
  ...AAPLX,
  symbol: "dAAPLx",
  mint: "AAbNhnPT35sgR1KRrMzNhsuLjT2XPA2S83ABbJPCuAB1",
  network: "solana-devnet",
};

describe("the paid intelligence tools", () => {
  let server: Server;
  let base: string;
  let tape: PriceTape;
  let platform: StockPlatform;

  const post = (side: PriceSide, source: string, price: number, mint = AAPLX.mint) =>
    tape.record(mint, side, { t: NOW, price, source });

  /** 5 USDC at `price` per UI share, expressed in the raw units a venue quotes in. */
  const rawFor = (price: number, slippageBps = 0) =>
    String(Math.floor(((5 / price) * ((10_000 - slippageBps) / 10_000) / MULTIPLIER) * 1e8));

  const start = async (options: { paid: boolean; proxyKey?: string }) => {
    tape = new PriceTape({ now: () => NOW });
    const governor = new StockGovernor({
      owner: "owner:test",
      operator: "operator:test",
      usdcMint: SOLANA_USDC_MINT,
      instruments: [TEST_MINT],
      policy: { perTradeCapUsdc: 10_000_000n, epochCapUsdc: 50_000_000n, epochLengthSeconds: 86_400, approvedMints: new Set([TEST_MINT.mint]) },
      now: () => NOW,
    });
    platform = new StockPlatform({
      instruments: [TEST_MINT],
      watchInstruments: [...VERIFIED_XSTOCKS],
      agents: [{ agentId: "agent", operator: "operator:test", governor, credentials: [] }],
      quotes: { quote: async () => { throw new Error("not used"); } },
      executor: { execute: async () => { throw new Error("not used"); } },
      priceTape: tape,
      marketGuard: new TapeMarketGuard({
        tape,
        now: () => NOW,
        uiMultiplier: (mint) => (mint === AAPLX.mint ? MULTIPLIER : undefined),
        policy: { required_sides: ["reference"] },
      }),
      now: () => NOW,
    });
    const app = express();
    mountIntel(app, platform, options);
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  afterEach(async () => { await new Promise<void>((resolve) => server?.close(() => resolve())); });

  const check = (body: unknown) => fetch(`${base}/internal/intel/quote-check`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-quaestor-proxy-key": PROXY_KEY },
    body: JSON.stringify(body),
  });

  it("says for free what is for sale, for how much, and about which instruments", async () => {
    await start({ paid: true, proxyKey: PROXY_KEY });
    const index = await (await fetch(`${base}/v1/intel`)).json() as {
      tools: Array<{ id: string; priceUsd: string }>;
      instruments: Array<{ symbol: string; tradeable_here: boolean }>;
    };
    expect(index.tools.map((tool) => tool.id)).to.deep.equal(["quote-check", "market-evidence", "price-tape"]);
    // It answers for what it merely watches, and says which of them it also trades.
    expect(index.instruments.find((i) => i.symbol === "AAPLx")?.tradeable_here).to.equal(false);
    expect(index.instruments.find((i) => i.symbol === "dAAPLx")?.tradeable_here).to.equal(true);
  });

  it("passes a quote that is worse than the market only by its slippage", async () => {
    await start({ paid: false, proxyKey: PROXY_KEY });
    post("tokenized", "jupiter", 334.81);
    post("reference", "backpack-index", 335.24);
    const answer = await (await check({
      instrument: "AAPLx", usdc_in: "5000000", tokens_out: rawFor(334.81), min_tokens_out: rawFor(334.81, 50),
    })).json() as { verdict: string; quote: { deviation_bps: number; ui_multiplier: number; benchmark_side: string } };
    expect(answer.verdict).to.equal("within-market");
    // Priced in shares, not raw units: without the multiplier this reads ~33bps worse.
    expect(answer.quote.ui_multiplier).to.equal(MULTIPLIER);
    expect(answer.quote.deviation_bps).to.be.closeTo(50, 2);
    expect(answer.quote.benchmark_side).to.equal("tokenized");
  });

  it("calls a third too few tokens what it is, for a quote from any venue", async () => {
    await start({ paid: false, proxyKey: PROXY_KEY });
    post("tokenized", "jupiter", 334.81);
    post("reference", "backpack-index", 335.24);
    const answer = await (await check({ instrument: "AAPL", usdc_in: "5000000", tokens_out: "1000000", venue: "some-dex" })).json() as {
      verdict: string; refusal: { code: string }; reading: string;
    };
    expect(answer.verdict).to.equal("off-market");
    expect(answer.refusal.code).to.equal("QUOTE_OFF_MARKET");
    expect(answer.reading).to.contain("worse than the market");
  });

  it("measures the floor, so an honest estimate cannot hide a robbery underneath it", async () => {
    await start({ paid: false, proxyKey: PROXY_KEY });
    post("tokenized", "jupiter", 334.81);
    post("reference", "backpack-index", 335.24);
    const answer = await (await check({
      instrument: "AAPLx", usdc_in: "5000000", tokens_out: rawFor(334.81), min_tokens_out: "700000",
    })).json() as { verdict: string };
    expect(answer.verdict).to.equal("off-market");
  });

  it("will not vouch for a quote when it has no fresh price to measure it against", async () => {
    await start({ paid: false, proxyKey: PROXY_KEY });
    const answer = await (await check({ instrument: "AAPLx", usdc_in: "5000000", tokens_out: rawFor(334.81) })).json() as {
      verdict: string; refusal: { code: string };
    };
    // Not "fair", and not "off-market" either: it does not know, and says so.
    expect(answer.verdict).to.equal("cannot-vouch");
    expect(answer.refusal.code).to.equal("MARKET_DATA_UNAVAILABLE");
  });

  it("refuses input it cannot price rather than guessing at it", async () => {
    await start({ paid: false, proxyKey: PROXY_KEY });
    expect((await check({ instrument: "DOGE", usdc_in: "5000000", tokens_out: "1" })).status).to.equal(404);
    expect((await check({ instrument: "AAPLx", usdc_in: "5.0", tokens_out: "1" })).status).to.equal(400);
    expect((await check({ instrument: "AAPLx", usdc_in: "5000000", tokens_out: "100", min_tokens_out: "200" })).status).to.equal(400);
    expect((await check({ instrument: "AAPLx", usdc_in: "0", tokens_out: "100" })).status).to.equal(400);
  });

  it("keeps the proxy routes behind their key, and does not mount them without one", async () => {
    await start({ paid: false, proxyKey: PROXY_KEY });
    const noKey = await fetch(`${base}/internal/intel/market-evidence?instrument=AAPLx`);
    expect(noKey.status).to.equal(401);
    const wrongKey = await fetch(`${base}/internal/intel/market-evidence?instrument=AAPLx`, { headers: { "x-quaestor-proxy-key": "x".repeat(PROXY_KEY.length) } });
    expect(wrongKey.status).to.equal(401);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await start({ paid: false });
    expect((await fetch(`${base}/internal/intel/market-evidence?instrument=AAPLx`, { headers: { "x-quaestor-proxy-key": PROXY_KEY } })).status).to.equal(404);
  });

  it("gives the same check away for what is traded here, and only for that", async () => {
    // A governed quote already carries this verdict, so charging to see it
    // again for the same instrument would be selling back what is free.
    await start({ paid: false, proxyKey: PROXY_KEY });
    post("reference", "backpack-index", 335.24, TEST_MINT.mint);
    const fair = String(Math.floor((5 / 335.24) * 1e8));
    const listed = await platform.checkListedQuote(TEST_MINT.mint, { usdcIn: 5_000_000n, tokensOut: BigInt(fair) });
    expect(listed.allowed).to.equal(true);
    expect(listed.quote?.benchmark_side).to.equal("reference");

    // AAPLx is watched, not traded: asking about it is the paid tool's job.
    let refusal: { code?: string; httpStatus?: number } = {};
    try {
      await platform.checkListedQuote(AAPLX.mint, { usdcIn: 5_000_000n, tokensOut: 1_000_000n });
    } catch (error) {
      refusal = error as { code?: string; httpStatus?: number };
    }
    expect(refusal.code).to.equal("UNKNOWN_INSTRUMENT");
    expect(refusal.httpStatus).to.equal(404);
  });

  it("publishes the owner's limits, which are policy and not a secret", async () => {
    await start({ paid: false });
    const limits = platform.discovery().limits;
    expect(limits?.per_trade_cap_usdc).to.equal("10000000");
    expect(limits?.epoch_cap_usdc).to.equal("50000000");
    expect(limits?.min_trade_usdc).to.equal("1000000");
    expect(limits?.approved_venues).to.deep.equal(["jupiter"]);
  });

  it("does not offer the public routes at all when nothing is there to collect payment", async () => {
    // A paid tool served free because a payment lane failed to mount would be a
    // quiet loss; better that the route is simply not there.
    await start({ paid: false, proxyKey: PROXY_KEY });
    expect((await fetch(`${base}/v1/intel/market-evidence?instrument=AAPLx`)).status).to.equal(404);
    expect((await fetch(`${base}/v1/intel`)).status).to.equal(200);
  });
});
