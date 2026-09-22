import { expect } from "chai";
import { CURVE_SEGMENTS, planStockLaunch, premiumBps } from "../stocks/dbc-launch";

describe("a DBC launch anchored to a price that already exists", () => {
  const plan = planStockLaunch({ referenceUsd: 335, bandBps: 300, raiseUsdc: 50_000 });

  it("keeps the whole curve inside the band, so there is no run from zero", () => {
    expect(plan.openingPriceUsd).to.be.closeTo(335 * 0.97, 0.01);
    expect(plan.graduationPriceUsd).to.be.closeTo(335 * 1.03, 0.01);
    expect(plan.segments).to.have.length(CURVE_SEGMENTS);
    for (const segment of plan.segments) {
      expect(segment.upToUsd).to.be.greaterThan(plan.openingPriceUsd);
      expect(segment.upToUsd).to.be.at.most(plan.graduationPriceUsd + 0.001);
    }
    // Every step is a step up: a curve that ever turned back would sell cheaper to later buyers.
    const tops = plan.segments.map((s) => s.upToUsd);
    expect([...tops].sort((a, b) => a - b)).to.deep.equal(tops);
  });

  it("puts its depth at the reference and thins toward the edges, symmetrically", () => {
    const depths = plan.segments.map((s) => s.relativeDepth);
    expect(depths[7]).to.equal(1);
    expect(depths[8]).to.equal(1);
    expect(depths[0]).to.be.lessThan(0.2);
    expect(depths).to.deep.equal([...depths].reverse());
    for (let i = 1; i <= 7; i += 1) expect(depths[i]).to.be.greaterThan(depths[i - 1]);
  });

  it("sizes the supply from the raise, and reports what the built curve really needs", () => {
    // One token is one share of exposure, so a $50k raise at $335 is a few hundred tokens.
    expect(plan.totalSupply).to.be.within(290, 320);
    expect(plan.graduationUsdc).to.be.closeTo(50_000, 1_500);
    const bigger = planStockLaunch({ referenceUsd: 335, bandBps: 300, raiseUsdc: 500_000 });
    expect(bigger.graduationUsdc / plan.graduationUsdc).to.be.closeTo(10, 0.3);
  });

  it("is a function of its inputs and nothing else", () => {
    const again = planStockLaunch({ referenceUsd: 335, bandBps: 300, raiseUsdc: 50_000 });
    expect(again.config.sqrtStartPrice.toString()).to.equal(plan.config.sqrtStartPrice.toString());
    expect(again.config.migrationQuoteThreshold.toString()).to.equal(plan.config.migrationQuoteThreshold.toString());
    expect(again.config.curve.map((p) => p.liquidity.toString())).to.deep.equal(plan.config.curve.map((p) => p.liquidity.toString()));
  });

  it("can spread depth evenly when asked, and says which it did", () => {
    const flat = planStockLaunch({ referenceUsd: 335, bandBps: 300, raiseUsdc: 50_000, concentration: 0 });
    expect(new Set(flat.segments.map((s) => s.relativeDepth)).size).to.equal(1);
    expect(flat.explanation.join(" ")).to.contain("spread evenly");
    expect(plan.explanation.join(" ")).to.contain("Depth peaks at the reference");
  });

  it("charges the first buyer more, not less", () => {
    const fee = plan.config.poolFees.baseFee;
    expect(plan.input.startingFeeBps).to.be.greaterThan(plan.input.endingFeeBps);
    expect(fee.cliffFeeNumerator.toString()).to.equal(String(plan.input.startingFeeBps * 100_000));
  });

  it("refuses to plan around a price that is not one", () => {
    expect(() => planStockLaunch({ referenceUsd: 0, bandBps: 300, raiseUsdc: 50_000 })).to.throw("referenceUsd must be positive");
    expect(() => planStockLaunch({ referenceUsd: Number.NaN, bandBps: 300, raiseUsdc: 50_000 })).to.throw("must be a number");
    expect(() => planStockLaunch({ referenceUsd: 335, bandBps: 10, raiseUsdc: 50_000 })).to.throw("bandBps");
    expect(() => planStockLaunch({ referenceUsd: 335, bandBps: 300, raiseUsdc: 5 })).to.throw("raiseUsdc");
    expect(() => planStockLaunch({ referenceUsd: 335, bandBps: 300, raiseUsdc: 50_000, startingFeeBps: 10, endingFeeBps: 25 })).to.throw("fees");
  });

  it("measures a pool against its anchor in the units the gate speaks", () => {
    expect(premiumBps(345.05, 335)).to.equal(300);
    expect(premiumBps(324.95, 335)).to.equal(-300);
  });
});

describe("watching a curve after it has launched", () => {
  const { assessCurve, AT_OPENING_RANGE } = require("../stocks/dbc-launch") as typeof import("../stocks/dbc-launch");
  const curve = { openingPriceUsd: 324.46, graduationPriceUsd: 344.53, anchoredToUsd: 334.49, graduated: false };

  it("is tracking while the share is inside the curve's range and buyers have moved the pool, and says how far it sits", () => {
    const seen = assessCurve({ ...curve, poolPriceUsd: 330, referenceUsd: 334.47 });
    expect(seen.health).to.equal("tracking");
    expect(seen.premiumBps).to.equal(-134);
    expect(seen.referenceDriftBps).to.equal(-1);
    expect(seen.rangePosition).to.equal(0.276);
  });

  it("does not call a pool nobody has moved tracking: it is at its opening price, waiting for buyers", () => {
    // The devnet curve as the hub read it on 22 Sep: 36.73 USDC in, the share up 174 bps since launch.
    const seen = assessCurve({ ...curve, poolPriceUsd: 324.51723, referenceUsd: 340.29517 });
    expect(seen.health).to.equal("at-opening");
    expect(seen.premiumBps).to.equal(-464);
    expect(seen.referenceDriftBps).to.equal(174);
    expect(seen.rangePosition).to.equal(0.0029);
    expect(seen.summary).to.contain("464 bps under the share at $340.30").and.to.contain("(+174 bps)").and.to.contain("waiting for buyers");
  });

  it("leaves the opening once the pool has climbed a hundredth of its range", () => {
    const step = (curve.graduationPriceUsd - curve.openingPriceUsd) * AT_OPENING_RANGE;
    expect(assessCurve({ ...curve, poolPriceUsd: curve.openingPriceUsd + step * 0.9, referenceUsd: 334.47 }).health).to.equal("at-opening");
    expect(assessCurve({ ...curve, poolPriceUsd: curve.openingPriceUsd + step * 1.1, referenceUsd: 334.47 }).health).to.equal("tracking");
  });

  it("still says the share has left the range when the pool is at its opening price: that is the state to act on", () => {
    expect(assessCurve({ ...curve, poolPriceUsd: 324.5, referenceUsd: 351 }).health).to.equal("reference-above-range");
    expect(assessCurve({ ...curve, poolPriceUsd: 324.5, referenceUsd: 310 }).health).to.equal("reference-below-range");
  });

  it("warns that a share above the range means the curve graduates at a discount", () => {
    const seen = assessCurve({ ...curve, poolPriceUsd: 330, referenceUsd: 351 });
    expect(seen.health).to.equal("reference-above-range");
    expect(seen.summary).to.contain("graduate at a discount");
    expect(seen.referenceDriftBps).to.equal(494);
  });

  it("warns that a share below the range strands the curve above fair value", () => {
    const seen = assessCurve({ ...curve, poolPriceUsd: 324.5, referenceUsd: 310 });
    expect(seen.health).to.equal("reference-below-range");
    expect(seen.summary).to.contain("stranded");
    expect(seen.premiumBps).to.be.greaterThan(400);
  });

  it("claims no health without a reference, rather than guessing one", () => {
    const seen = assessCurve({ ...curve, poolPriceUsd: 324.5 });
    expect(seen.health).to.equal(undefined);
    expect(seen.premiumBps).to.equal(undefined);
    expect(seen.rangePosition).to.be.a("number");
    expect(assessCurve({ ...curve, poolPriceUsd: 324.5, referenceUsd: Number.NaN }).health).to.equal(undefined);
  });

  it("reports a finished curve as finished, whatever the share is doing", () => {
    expect(assessCurve({ ...curve, graduated: true, referenceUsd: 400 }).health).to.equal("graduated");
  });

  it("refuses a range that does not run upward", () => {
    expect(() => assessCurve({ ...curve, graduationPriceUsd: 300 })).to.throw("range must run upward");
  });
});
