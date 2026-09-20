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
