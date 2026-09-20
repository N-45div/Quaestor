import { expect } from "chai";
import {
  PreStocksMarkSource,
  PriceSampler,
  PriceTape,
  SOLANA_USDC_MINT,
  StockGovernor,
  StockPlatform,
  TapeMarketGuard,
  VERIFIED_XSTOCKS,
  type MarketPolicy,
  type PriceSide,
  type StockInstrument,
} from "../stocks";

/** Saturday afternoon in New York: no US session, which a pre-IPO token does not have anyway. */
const NOW = Math.floor(Date.parse("2026-09-19T18:00:00Z") / 1000);
const AAPLX = VERIFIED_XSTOCKS.find((i) => i.underlyingSymbol === "AAPL") as StockInstrument;

const preStock = (symbol: string, mint: string, mark: number, token: number, observedAt = NOW): StockInstrument => ({
  ...AAPLX,
  symbol,
  name: symbol,
  mint,
  provider: "prestocks",
  underlyingSymbol: undefined,
  enabled: false,
  executionStatus: "discovery-only",
  referenceData: {
    observedAt: new Date(observedAt * 1000).toISOString(),
    markPriceUsd: String(mark),
    tokenPriceUsd: String(token),
  },
} as StockInstrument);

const SPACEX = "SPCX1111111111111111111111111111111111111111";
const OPENAI = "oPAi1111111111111111111111111111111111111111";

const PRE_IPO: Partial<MarketPolicy> = {
  required_sides: ["tokenized", "reference"] as PriceSide[],
  max_price_age_seconds: 300,
  max_source_disagreement_bps: 300,
  max_absolute_premium_bps: 1500,
  max_absolute_premium_bps_after_hours: 1500,
  max_quote_deviation_bps: 500,
};

describe("a policy for each kind of instrument", () => {
  let tape: PriceTape;
  const guard = (policyFor?: (mint: string) => string | undefined, policies = { "pre-ipo": PRE_IPO }) =>
    new TapeMarketGuard({ tape, now: () => NOW, policy: { required_sides: ["tokenized", "reference"] as PriceSide[] }, policies, policyFor });
  const post = (mint: string, side: PriceSide, source: string, price: number, age = 0) =>
    tape.record(mint, side, { t: NOW - age, price, source });

  beforeEach(() => { tape = new PriceTape({ now: () => NOW }); });

  it("judges a pre-IPO token by the owner's numbers for pre-IPO tokens, and says so", async () => {
    // Ten percent over its mark: a break for a listed share, ordinary for this.
    post(SPACEX, "tokenized", "jupiter", 110);
    post(SPACEX, "reference", "prestocks-mark", 100);
    const scoped = await guard((mint) => (mint === SPACEX ? "pre-ipo" : undefined)).assess(preStock("SPACEX", SPACEX, 100, 110));
    expect(scoped.allowed).to.equal(true);
    expect(scoped.policy_scope).to.equal("pre-ipo");
    expect(scoped.policy.max_absolute_premium_bps_after_hours).to.equal(1500);

    const unscoped = await guard().assess(preStock("SPACEX", SPACEX, 100, 110));
    expect(unscoped.policy_scope).to.equal("default");
    expect(unscoped.refusal?.code).to.equal("PRICE_DISLOCATION");
  });

  it("still refuses a pre-IPO token that has come loose from its mark", async () => {
    post(SPACEX, "tokenized", "jupiter", 79.76);
    post(SPACEX, "reference", "prestocks-mark", 100);
    const verdict = await guard(() => "pre-ipo").assess(preStock("SPACEX", SPACEX, 100, 79.76));
    expect(verdict.refusal?.code).to.equal("PRICE_DISLOCATION");
    expect(verdict.premium_bps).to.equal(-2024);
  });

  it("leaves every other instrument on the default policy", async () => {
    post(AAPLX.mint, "tokenized", "jupiter", 110);
    post(AAPLX.mint, "reference", "backpack-index", 100);
    const verdict = await guard((mint) => (mint === SPACEX ? "pre-ipo" : undefined)).assess(AAPLX);
    expect(verdict.policy_scope).to.equal("default");
    expect(verdict.refusal?.code).to.equal("PRICE_DISLOCATION");
  });

  it("does not believe a mark that reaches it as two different numbers", async () => {
    // Both are the issuer's word, by two routes. If the routes disagree, one of
    // them is wrong about what the issuer said, and the gate will not pick.
    post(OPENAI, "tokenized", "jupiter", 812);
    post(OPENAI, "reference", "prestocks-mark", 800);
    post(OPENAI, "reference", "jupiter-issuer", 850);
    const verdict = await guard(() => "pre-ipo").assess(preStock("OPENAI", OPENAI, 800, 812));
    expect(verdict.refusal?.code).to.equal("MARKET_SOURCES_DISAGREE");
    expect(verdict.refusal?.message).to.contain("jupiter-issuer").and.to.contain("prestocks-mark");
  });

  it("checks a named policy when it is built, not when it is first needed", () => {
    expect(() => guard(undefined, { "pre-ipo": { max_absolute_premium_bps: -1 } })).to.throw();
    expect(() => guard(undefined, { default: {} } as never)).to.throw("cannot be redefined");
  });

  it("refuses to fall back to the default when an instrument names a policy that does not exist", async () => {
    post(SPACEX, "tokenized", "jupiter", 100);
    post(SPACEX, "reference", "prestocks-mark", 100);
    let thrown: unknown;
    try {
      await guard(() => "exotic").assess(preStock("SPACEX", SPACEX, 100, 100));
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).to.contain('no market policy is named "exotic"');
  });
});

describe("PreStocks on the price tape", () => {
  const registry = (listed: StockInstrument[] | Error) => ({
    instruments: async () => { if (listed instanceof Error) throw listed; return listed; },
  });

  it("records the issuer's mark, and not the token price the issuer passes along", async () => {
    // The provider's token price is Jupiter's number relayed. Recording it would
    // make one observation look like two sources that agree.
    const source = new PreStocksMarkSource(registry([preStock("SPACEX", SPACEX, 423, 337.4)]));
    const samples = await source.sample();
    expect(samples).to.deep.equal([
      { mint: SPACEX, side: "reference", point: { t: NOW, price: 423, source: "prestocks-mark" } },
    ]);
    expect(source.known().map((i) => i.symbol)).to.deep.equal(["SPACEX"]);
  });

  it("stamps a price with when the provider said it, so a quiet provider goes stale", async () => {
    const tape = new PriceTape({ now: () => NOW });
    const tenMinutesAgo = NOW - 600;
    const source = new PreStocksMarkSource(registry([preStock("SPACEX", SPACEX, 100, 101, tenMinutesAgo)]));
    await new PriceSampler(tape, () => [], [source]).tick();
    tape.record(SPACEX, "tokenized", { t: NOW, price: 101, source: "jupiter" });
    const guard = new TapeMarketGuard({ tape, now: () => NOW, policies: { "pre-ipo": PRE_IPO }, policyFor: () => "pre-ipo" });
    const verdict = await guard.assess(preStock("SPACEX", SPACEX, 100, 101, tenMinutesAgo));
    expect(verdict.refusal?.code).to.equal("MARKET_DATA_STALE");
  });

  it("skips a row it cannot price instead of recording a guess", async () => {
    const broken = { ...preStock("KALSHI", OPENAI, 1, 1), referenceData: { observedAt: "not a date", markPriceUsd: "x" } } as unknown as StockInstrument;
    const unpriced = { ...preStock("ANDURIL", SPACEX, 1, 1), referenceData: undefined } as StockInstrument;
    expect(await new PreStocksMarkSource(registry([broken, unpriced])).sample()).to.deep.equal([]);
  });

  it("lets the platform answer for what was discovered while it ran", async () => {
    const tape = new PriceTape({ now: () => NOW });
    const source = new PreStocksMarkSource(registry([preStock("SPACEX", SPACEX, 100, 108)]));
    const governor = new StockGovernor({
      owner: "owner:test", operator: "operator:test", usdcMint: SOLANA_USDC_MINT, instruments: [AAPLX],
      policy: { perTradeCapUsdc: 10_000_000n, epochCapUsdc: 50_000_000n, epochLengthSeconds: 86_400, approvedMints: new Set([AAPLX.mint]) },
      now: () => NOW,
    });
    const platform = new StockPlatform({
      instruments: [AAPLX],
      watchInstruments: () => source.known(),
      agents: [{ agentId: "agent", operator: "operator:test", governor, credentials: [] }],
      quotes: { quote: async () => { throw new Error("not used"); } },
      executor: { execute: async () => { throw new Error("not used"); } },
      priceTape: tape,
      marketGuard: new TapeMarketGuard({
        tape, now: () => NOW, policies: { "pre-ipo": PRE_IPO },
        policyFor: (mint) => (source.known().some((i) => i.mint === mint) ? "pre-ipo" : undefined),
      }),
      now: () => NOW,
    });
    // Nothing discovered yet: it is not watched, and says so.
    expect(platform.watched().map((w) => w.symbol)).to.deep.equal(["AAPLx"]);
    await new PriceSampler(tape, () => source.known(), [source]).tick();
    tape.record(SPACEX, "tokenized", { t: NOW, price: 108, source: "jupiter" });
    expect(platform.watched().map((w) => w.symbol)).to.deep.equal(["AAPLx", "SPACEX"]);
    const verdict = await platform.watchMarket("SPACEX");
    expect(verdict.policy_scope).to.equal("pre-ipo");
    expect(verdict.premium_bps).to.equal(800);
    expect(verdict.allowed).to.equal(true);
    // Watched is not tradeable: the trading path still does not know it.
    expect(platform.watched().find((w) => w.symbol === "SPACEX")?.tradeable_here).to.equal(false);
  });
});
