import { expect } from "chai";
import {
  DevnetQuoteProvider,
  NoRouteError,
  SOLANA_USDC_MINT,
  StockGovernor,
  StockPlatform,
  StockPlatformError,
  VERIFIED_XSTOCKS,
  type JupiterQuoteFetcher,
  type StockInstrument,
  type VenueId,
} from "../stocks";

describe("Quaestor Stocks — the venue follows the instrument", () => {
  const nowSeconds = 1_700_000_000;
  const listed = VERIFIED_XSTOCKS[0];
  const instrument = (mint: string, tradableVenues?: VenueId[]): StockInstrument => ({
    ...listed,
    symbol: `T${mint.slice(0, 3)}`,
    mint,
    tradableVenues,
    routabilityUnknownVenues: [],
  });
  const onCurve = instrument("CurveToken1111111111111111111111111111111111", ["meteora-dbc"]);
  const unmeasured = instrument("Unmeasured111111111111111111111111111111111");
  const onBoth = instrument("BothVenues1111111111111111111111111111111111", ["jupiter", "meteora-dbc"]);
  const onUnquotable = instrument("DlmmOnly11111111111111111111111111111111111", ["meteora-dlmm"]);
  const nowhere = instrument("Nowhere111111111111111111111111111111111111", []);
  const all = [onCurve, unmeasured, onBoth, onUnquotable, nowhere];

  const sourceNamed = (name: string, fail?: () => Error): JupiterQuoteFetcher => ({
    quote: async (inputMint, outputMint, amount) => {
      if (fail) throw fail();
      return {
        quoteId: `${name}-${outputMint}-${amount}`,
        inputMint,
        outputMint,
        inAmount: amount,
        outAmount: amount * 2n,
        minimumOutput: (amount * 198n) / 100n,
        route: `${name} / test-liquidity`,
        expiresAt: nowSeconds + 30,
      };
    },
  });

  const build = (curve: JupiterQuoteFetcher = sourceNamed("meteora-dbc")) => new StockPlatform({
    instruments: all,
    agents: [{
      agentId: "agent",
      operator: "operator:test",
      governor: new StockGovernor({
        owner: "owner:test",
        operator: "operator:test",
        usdcMint: SOLANA_USDC_MINT,
        instruments: all,
        policy: {
          perTradeCapUsdc: 60_000_000n,
          epochCapUsdc: 100_000_000n,
          epochLengthSeconds: 3600,
          approvedMints: new Set(all.map((i) => i.mint)),
          approvedVenues: ["jupiter", "meteora-dbc", "meteora-dlmm"],
        },
        now: () => nowSeconds,
      }),
      credentials: [{ token: "a-strong-enough-token", allowedMints: new Set(all.map((i) => i.mint)) }],
    }],
    quotes: sourceNamed("jupiter"),
    venueQuotes: { "meteora-dbc": curve },
    executor: { execute: async (_i, q) => ({ txSignature: "sig", actualOutput: q.outAmount, outcome: "settled" }) },
    now: () => nowSeconds,
  });

  it("quotes a curve's token on its curve when no venue is named", async () => {
    const quote = await build().createQuote("agent", onCurve.mint, "1000000");
    expect(quote.venue).to.equal("meteora-dbc");
    expect(quote.route).to.contain("meteora-dbc");
  });

  it("keeps the default for an instrument nobody has measured, or that nothing fills", async () => {
    // Absent is not "no", and an empty list is the default's to answer for.
    expect((await build().createQuote("agent", unmeasured.mint, "1000000")).venue).to.equal("jupiter");
    expect((await build().createQuote("agent", nowhere.mint, "1000000")).venue).to.equal("jupiter");
  });

  it("keeps the default when the default can fill it too", async () => {
    expect((await build().createQuote("agent", onBoth.mint, "1000000")).venue).to.equal("jupiter");
  });

  it("does not pick a venue this deployment cannot quote", async () => {
    expect((await build().createQuote("agent", onUnquotable.mint, "1000000")).venue).to.equal("jupiter");
  });

  it("still goes where it is told when a venue is named", async () => {
    expect((await build().createQuote("agent", onCurve.mint, "1000000", "jupiter")).venue).to.equal("jupiter");
  });

  it("reports a venue's no as NO_ROUTE, which is not worth retrying", async () => {
    const error = await build(sourceNamed("meteora-dbc", () => new NoRouteError("this curve has graduated")))
      .createQuote("agent", onCurve.mint, "1000000")
      .then(() => undefined, (e) => e);
    expect(error).to.be.instanceOf(StockPlatformError);
    expect(error.code).to.equal("NO_ROUTE");
    expect(error.httpStatus).to.equal(422);
    expect(error.message).to.contain("graduated");
  });

  it("leaves an outage an outage", async () => {
    const error = await build(sourceNamed("meteora-dbc", () => new Error("fetch failed")))
      .createQuote("agent", onCurve.mint, "1000000")
      .then(() => undefined, (e) => e);
    expect(error).to.not.be.instanceOf(StockPlatformError);
    expect(error.message).to.equal("fetch failed");
  });

  it("a test venue bound to one mint will not quote another at that mint's price", async () => {
    const quotes = new DevnetQuoteProvider({ venue: "router-stub", mint: onBoth.mint, instrumentDecimals: 8, priceUsd: async () => 334.5 });
    expect((await quotes.quote(SOLANA_USDC_MINT, onBoth.mint, 2_000_000n)).outAmount > 0n).to.equal(true);
    const error = await quotes.quote(SOLANA_USDC_MINT, onCurve.mint, 2_000_000n).then(() => undefined, (e) => e);
    expect(error).to.be.instanceOf(NoRouteError);
  });
});
