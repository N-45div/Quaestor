import { expect } from "chai";
import {
  PriceTape,
  TapeMarketGuard,
  VERIFIED_XSTOCKS,
  type MarketPolicy,
  type PriceSide,
  type QuotedPrice,
  type StockInstrument,
} from "../stocks";

/** Wednesday 10:00 in New York — the middle of a regular session. */
const REGULAR = Math.floor(Date.parse("2026-09-16T14:00:00Z") / 1000);
const OVERNIGHT = Math.floor(Date.parse("2026-09-16T05:00:00Z") / 1000);
const WEEKEND = Math.floor(Date.parse("2026-09-19T14:00:00Z") / 1000);

const AAPLX = VERIFIED_XSTOCKS.find((i) => i.underlyingSymbol === "AAPL") as StockInstrument;
/** The multiplier Jupiter published for AAPLx: raw base units per UI share. */
const SCALED = 1.0032690125398187;

describe("the price gate", () => {
  let now = REGULAR;
  let tape: PriceTape;

  const guard = (policy: Partial<MarketPolicy> = {}, uiMultiplier?: number) =>
    new TapeMarketGuard({
      tape,
      now: () => now,
      uiMultiplier: uiMultiplier === undefined ? undefined : () => uiMultiplier,
      policy: { required_sides: ["tokenized", "reference"] as PriceSide[], ...policy },
    });

  /** Put a price on the tape as `source`, `ageSeconds` ago. */
  const post = (side: PriceSide, source: string, price: number, ageSeconds = 0) =>
    tape.record(AAPLX.mint, side, { t: now - ageSeconds, price, source });

  /** A quote buying `usdc` dollars of AAPLx at `pricePerShare`, with a floor `slippageBps` worse. */
  const quoteAt = (pricePerShare: number, usdc = 5, slippageBps = 50, multiplier = 1): QuotedPrice => {
    const shares = usdc / pricePerShare;
    const raw = (uiShares: number) => BigInt(Math.floor((uiShares / multiplier) * 10 ** 8));
    return {
      quote_id: "q1",
      venue: "jupiter",
      in_amount: BigInt(usdc * 1_000_000),
      out_amount: raw(shares),
      minimum_output: raw((shares * (10_000 - slippageBps)) / 10_000),
      out_decimals: 8,
    };
  };

  beforeEach(() => {
    now = REGULAR;
    tape = new PriceTape({ now: () => now });
  });

  describe("checking the quote against the market", () => {
    it("allows a quote whose floor sits inside the band", async () => {
      post("tokenized", "jupiter", 336.99);
      post("reference", "backpack-index", 336.88);
      const g = guard();
      const checked = g.checkQuote(await g.assess(AAPLX), quoteAt(336.99));
      expect(checked.allowed).to.equal(true);
      expect(checked.quote?.benchmark_side).to.equal("tokenized");
      // The floor is a worse price than the market by exactly the slippage.
      expect(checked.quote?.deviation_bps).to.be.closeTo(50, 1);
    });

    it("refuses a quote the chain would have settled happily", async () => {
      // This is the gap the gate exists for. The program checks that the vault
      // spent no more than it authorised and the position gained at least
      // minOutput — and both hold perfectly here, because minOutput came from
      // this same quote. Only a price observed elsewhere can say it is robbery.
      post("tokenized", "jupiter", 336.99);
      post("reference", "backpack-index", 336.88);
      const g = guard();
      const checked = g.checkQuote(await g.assess(AAPLX), quoteAt(500));
      expect(checked.allowed).to.equal(false);
      expect(checked.refusal?.code).to.equal("QUOTE_OFF_MARKET");
      expect(checked.refusal?.message).to.contain("a share");
      expect(checked.quote?.deviation_bps).to.be.greaterThan(4_000);
    });

    it("measures the floor the chain enforces, not the fill the venue predicts", async () => {
      post("tokenized", "jupiter", 336.99);
      post("reference", "backpack-index", 336.88);
      // An honest-looking expected fill with a floor that permits daylight
      // robbery: the venue may deliver the floor and keep the difference.
      const generous = quoteAt(336.99);
      const g = guard();
      const checked = g.checkQuote(await g.assess(AAPLX), {
        ...generous,
        minimum_output: generous.minimum_output / 2n,
      });
      expect(checked.allowed).to.equal(false);
      expect(checked.refusal?.code).to.equal("QUOTE_OFF_MARKET");
      expect(checked.quote?.expected_price_usd).to.be.closeTo(336.99, 0.1);
      // Twice the market, plus the 50bps the floor was already worse by.
      expect(checked.quote?.floor_price_usd).to.be.closeTo(677.37, 1);
    });

    it("reads a scaled-UI mint's raw amount as the shares it is worth", async () => {
      post("tokenized", "jupiter", 336.99);
      post("reference", "backpack-index", 336.88);
      // Jupiter prices one *UI* share; the quote is denominated in raw units,
      // and xStocks accrue dividends into the multiplier between the two.
      const quote = quoteAt(336.99, 5, 0, SCALED);
      const scaled = guard({}, SCALED);
      const naive = guard({}, 1);
      expect(scaled.checkQuote(await scaled.assess(AAPLX), quote).quote?.deviation_bps).to.be.closeTo(0, 1);
      // Ignoring it prices the trade ~33bps wrong today, and by more each quarter.
      expect(naive.checkQuote(await naive.assess(AAPLX), quote).quote?.deviation_bps).to.be.closeTo(33, 2);
    });

    it("falls back to the underlying when the token has no market of its own", async () => {
      post("reference", "backpack-index", 336.88);
      const g = guard({ required_sides: ["reference"] });
      const checked = g.checkQuote(await g.assess(AAPLX), quoteAt(336.88));
      expect(checked.quote?.benchmark_side).to.equal("reference");
      expect(checked.allowed).to.equal(true);
      expect(checked.premium_bps).to.equal(undefined);
    });
  });

  describe("agreement between sources", () => {
    it("refuses when two sources price the same side differently", async () => {
      post("tokenized", "jupiter", 336.99);
      post("reference", "backpack-index", 336.88);
      post("reference", "jupiter-issuer", 352.00);
      const assessment = await guard().assess(AAPLX);
      expect(assessment.allowed).to.equal(false);
      expect(assessment.refusal?.code).to.equal("MARKET_SOURCES_DISAGREE");
      expect(assessment.refusal?.message).to.contain("backpack-index and jupiter-issuer");
      expect(assessment.consensus.reference?.spread_bps).to.be.greaterThan(400);
    });

    it("takes the median, so one broken source among three does not decide", async () => {
      post("tokenized", "jupiter", 336.99);
      post("reference", "backpack-index", 336.88);
      post("reference", "jupiter-issuer", 337.10);
      post("reference", "broken-feed", 0.01);
      const assessment = await guard({ max_source_disagreement_bps: 10_000_000 }).assess(AAPLX);
      expect(assessment.consensus.reference?.price).to.equal(336.88);
      expect(assessment.consensus.reference?.sources).to.have.length(3);
    });

    it("keeps the sources apart, which the merged series cannot", () => {
      post("reference", "backpack-index", 336.88);
      post("reference", "jupiter-issuer", 337.10);
      // One second, two sources: the chart's series keeps the last writer only.
      expect(tape.series(AAPLX.mint, "reference")).to.have.length(1);
      expect(tape.latestPerSource(AAPLX.mint, "reference").map((p) => p.source))
        .to.deep.equal(["backpack-index", "jupiter-issuer"]);
    });
  });

  describe("refusing to work from data it does not have", () => {
    it("refuses when nothing has published a required side", async () => {
      post("tokenized", "jupiter", 336.99);
      const assessment = await guard().assess(AAPLX);
      expect(assessment.allowed).to.equal(false);
      expect(assessment.refusal?.code).to.equal("MARKET_DATA_UNAVAILABLE");
      expect(assessment.refusal?.message).to.contain("reference");
    });

    it("refuses when the prices it has are too old to be prices", async () => {
      post("tokenized", "jupiter", 336.99);
      post("reference", "backpack-index", 336.88, 600);
      const assessment = await guard({ max_price_age_seconds: 180 }).assess(AAPLX);
      expect(assessment.allowed).to.equal(false);
      expect(assessment.refusal?.code).to.equal("MARKET_DATA_STALE");
      expect(assessment.refusal?.message).to.contain("600s old");
      // Still reported, so an operator can see what went quiet and when.
      expect(assessment.observations.map((o) => o.source)).to.contain("backpack-index");
    });

    it("refuses a quote it has no market to check", async () => {
      const g = guard();
      const assessment = await g.assess(AAPLX);
      expect(g.checkQuote(assessment, quoteAt(336.99)).quote).to.equal(undefined);
      expect(assessment.allowed).to.equal(false);
    });
  });

  describe("the gap between the token and its underlying", () => {
    it("refuses a dislocation during regular hours", async () => {
      post("tokenized", "jupiter", 360);
      post("reference", "backpack-index", 336.88);
      const assessment = await guard({ max_absolute_premium_bps: 300 }).assess(AAPLX);
      expect(assessment.premium_bps).to.be.greaterThan(600);
      expect(assessment.refusal?.code).to.equal("PRICE_DISLOCATION");
      expect(assessment.refusal?.message).to.contain("regular");
    });

    it("allows the same gap overnight, where arbitrage is weaker by design", async () => {
      now = OVERNIGHT;
      post("tokenized", "jupiter", 360);
      post("reference", "backpack-index", 336.88);
      const assessment = await guard({
        max_absolute_premium_bps: 300,
        max_absolute_premium_bps_after_hours: 800,
      }).assess(AAPLX);
      expect(assessment.session).to.equal("overnight");
      expect(assessment.allowed).to.equal(true);
    });

    it("lets an owner close the door on a session entirely", async () => {
      now = WEEKEND;
      post("tokenized", "jupiter", 336.99);
      post("reference", "backpack-index", 336.88);
      const assessment = await guard({ allowed_sessions: ["regular"] }).assess(AAPLX);
      expect(assessment.refusal?.code).to.equal("SESSION_CLOSED");
      expect(assessment.refusal?.message).to.contain("weekend");
    });
  });

  describe("a scheduled multiplier change", () => {
    /** 00:30 UTC the day after an ex-date, when xStocks activate a new multiplier. */
    const CHANGE = Math.floor(Date.parse("2026-09-17T00:30:00Z") / 1000);

    const scheduled = (changeAt: number | undefined, policy: Partial<MarketPolicy> = {}) =>
      new TapeMarketGuard({
        tape,
        now: () => now,
        multiplierChangeAt: (mint) => (mint === AAPLX.mint ? changeAt : undefined),
        policy: { required_sides: ["tokenized", "reference"] as PriceSide[], ...policy },
      });

    /** A calm, agreeing market, so the only thing left to refuse on is the clock. */
    const calm = () => {
      post("tokenized", "jupiter", 336.99);
      post("reference", "backpack-index", 336.88);
    };

    it("refuses ten minutes before the change, and names the moment", async () => {
      now = CHANGE - 600;
      calm();
      const assessment = await scheduled(CHANGE).assess(AAPLX);
      expect(assessment.allowed).to.equal(false);
      expect(assessment.refusal?.code).to.equal("MULTIPLIER_CHANGE");
      expect(assessment.refusal?.message).to.contain("changes at 2026-09-17T00:30:00.000Z, in 600s");
      expect(assessment.multiplier_change_at).to.equal("2026-09-17T00:30:00.000Z");
    });

    it("refuses ten minutes after it, because the pause runs both ways", async () => {
      now = CHANGE + 600;
      calm();
      const assessment = await scheduled(CHANGE).assess(AAPLX);
      expect(assessment.refusal?.code).to.equal("MULTIPLIER_CHANGE");
      expect(assessment.refusal?.message).to.contain("changed at 2026-09-17T00:30:00.000Z, 600s ago");
    });

    it("allows a trade twenty minutes away on either side", async () => {
      for (const offset of [-1_200, 1_200]) {
        now = CHANGE + offset;
        calm();
        const assessment = await scheduled(CHANGE).assess(AAPLX);
        expect(assessment.allowed, `${offset}s from the change`).to.equal(true);
        // Still reported, so a reader can see how near it came.
        expect(assessment.multiplier_change_at).to.equal("2026-09-17T00:30:00.000Z");
      }
    });

    it("does not refuse for want of a schedule: most mints never publish one", async () => {
      now = CHANGE;
      calm();
      // Nothing known, and the 0 Token-2022 writes where nothing was ever set.
      for (const changeAt of [undefined, 0]) {
        const assessment = await scheduled(changeAt).assess(AAPLX);
        expect(assessment.allowed).to.equal(true);
        expect(assessment.multiplier_change_at).to.equal(undefined);
      }
    });

    it("refuses at execution a quote that was fine when it was made", async () => {
      now = CHANGE - 960;
      calm();
      const g = scheduled(CHANGE);
      const checked = g.checkQuote(await g.assess(AAPLX), quoteAt(336.99));
      expect(checked.allowed).to.equal(true);
      // The agent takes two minutes to decide, and the window opens meanwhile.
      now += 120;
      calm();
      expect(g.revalidate(checked).refusal?.code).to.equal("MULTIPLIER_CHANGE");
    });

    it("lets an owner turn the pause off, and no further than that", async () => {
      now = CHANGE;
      calm();
      expect((await scheduled(CHANGE, { multiplier_change_window_seconds: 0 }).assess(AAPLX)).allowed).to.equal(true);
      expect(() => scheduled(CHANGE, { multiplier_change_window_seconds: -1 })).to.throw("non-negative");
    });
  });

  describe("deciding again at execution time", () => {
    it("re-reads the market, because that is what moves between quote and trade", async () => {
      post("tokenized", "jupiter", 336.99);
      post("reference", "backpack-index", 336.88);
      const g = guard({ max_quote_deviation_bps: 300 });
      const checked = g.checkQuote(await g.assess(AAPLX), quoteAt(336.99));
      expect(checked.allowed).to.equal(true);

      // The market moves away from the quote while the agent is deciding.
      now += 30;
      post("tokenized", "jupiter", 280);
      post("reference", "backpack-index", 280);
      const again = g.revalidate(checked);
      expect(again.allowed).to.equal(false);
      expect(again.refusal?.code).to.equal("QUOTE_OFF_MARKET");
      // The quote's own implied price is a fact and does not drift.
      expect(again.quote?.floor_price_usd).to.equal(checked.quote?.floor_price_usd);
      expect(again.quote?.benchmark_price_usd).to.equal(280);
    });

    it("hashes the evidence, not the moment", async () => {
      post("tokenized", "jupiter", 336.99);
      post("reference", "backpack-index", 336.88);
      const g = guard();
      const first = await g.assess(AAPLX);
      now += 45;
      const later = await g.assess(AAPLX);
      expect(later.evidence_hash).to.equal(first.evidence_hash);
      expect(later.observed_at).to.not.equal(first.observed_at);

      post("tokenized", "jupiter", 337.50);
      expect((await g.assess(AAPLX)).evidence_hash).to.not.equal(first.evidence_hash);
    });
  });

  describe("policy that would not be a gate", () => {
    it("refuses to be built requiring no side at all", () => {
      expect(() => guard({ required_sides: [] })).to.throw("at least one side");
    });

    it("refuses a negative limit", () => {
      expect(() => guard({ max_quote_deviation_bps: -1 })).to.throw("non-negative");
    });
  });
});
