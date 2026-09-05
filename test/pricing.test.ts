import { expect } from "chai";
import {
  HBAR_ASSET,
  TINYBAR_PER_HBAR,
  hbarFromTinybars,
  hbarPrice,
  meteredPrice,
  permitPrice,
  tinybarsFromHbar,
} from "../services/pricing";

describe("pricing (route permits)", () => {
  describe("tinybar conversion", () => {
    it("parses HBAR decimals exactly, without floating point", () => {
      expect(tinybarsFromHbar("1")).to.equal(TINYBAR_PER_HBAR);
      expect(tinybarsFromHbar("0.005")).to.equal(500_000n);
      expect(tinybarsFromHbar("0.00000001")).to.equal(1n);
      expect(tinybarsFromHbar("12.34567891")).to.equal(1_234_567_891n);
    });

    it("rejects amounts finer than a tinybar instead of rounding them", () => {
      expect(() => tinybarsFromHbar("0.000000001")).to.throw(/not an HBAR amount/);
      expect(() => tinybarsFromHbar("abc")).to.throw();
      expect(() => tinybarsFromHbar("-1")).to.throw();
    });

    it("round-trips through the display form", () => {
      for (const s of ["0.005", "1", "0.0005", "2.5", "0.00000001"]) {
        expect(hbarFromTinybars(tinybarsFromHbar(s))).to.equal(s);
      }
    });
  });

  describe("permitPrice", () => {
    const base = tinybarsFromHbar("0.005");

    it("charges base when nobody has reported the venue", () => {
      const q = permitPrice(base, 1, 0);
      expect(q.tinybars).to.equal(base);
      expect(q.multiplier).to.equal(1);
    });

    it("scales linearly with distinct human reporters", () => {
      expect(permitPrice(base, 1, 1).tinybars).to.equal(base * 2n);
      expect(permitPrice(base, 1, 3).tinybars).to.equal(base * 4n);
      expect(permitPrice(base, 2.5, 2).tinybars).to.equal(base * 6n);
    });

    it("is deterministic at 4 decimals of k", () => {
      const a = permitPrice(base, 1.2345, 7);
      const b = permitPrice(base, 1.2345, 7);
      expect(a.tinybars).to.equal(b.tinybars);
      // 1 + 1.2345·7 = 9.6415 → 0.005 × 9.6415 = 0.0482075 HBAR
      expect(hbarFromTinybars(a.tinybars)).to.equal("0.0482075");
    });

    it("prices a heavily-reported venue past a tight per-call cap", () => {
      // The refusal: the owner's INFERENCE per-call cap is 0.01 HBAR.
      const cap = tinybarsFromHbar("0.01");
      expect(permitPrice(base, 1, 0).tinybars <= cap).to.equal(true);
      expect(permitPrice(base, 1, 1).tinybars <= cap).to.equal(true);
      expect(permitPrice(base, 1, 2).tinybars > cap).to.equal(true);
    });

    it("refuses nonsense inputs", () => {
      expect(() => permitPrice(0n, 1, 0)).to.throw(/base/);
      expect(() => permitPrice(base, -1, 0)).to.throw(/k/);
      expect(() => permitPrice(base, 1, 1.5)).to.throw(/reporters/);
    });
  });

  describe("meteredPrice", () => {
    const unit = tinybarsFromHbar("0.001");

    it("bills per item", () => {
      expect(meteredPrice(unit, 3)).to.equal(unit * 3n);
    });

    it("never bills zero and clamps to the ceiling", () => {
      expect(meteredPrice(unit, 0)).to.equal(unit);
      expect(meteredPrice(unit, -4)).to.equal(unit);
      expect(meteredPrice(unit, Number.NaN)).to.equal(unit);
      expect(meteredPrice(unit, 10_000)).to.equal(unit * 50n);
      expect(meteredPrice(unit, 10_000, 5)).to.equal(unit * 5n);
    });
  });

  it("hbarPrice emits an x402 AssetAmount for native HBAR", () => {
    expect(hbarPrice(500_000n)).to.deep.equal({ asset: HBAR_ASSET, amount: "500000" });
    expect(HBAR_ASSET).to.equal("0.0.0");
  });
});
