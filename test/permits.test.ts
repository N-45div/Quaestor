import { expect } from "chai";
import { MemoryThreatFeed } from "../services/threatfeed";
import { createPermitPricer } from "../services/permits";
import { hbarFromTinybars } from "../services/pricing";

describe("permit pricer", () => {
  it("moves every tenant's price when one tenant reports", async () => {
    const feed = new MemoryThreatFeed();
    const pricer = createPermitPricer({ feed, baseHbar: "0.005", k: 1 });
    const before = await pricer.quote("0xdead");
    await feed.report({ venue: "0xdead", pattern: "prompt-injection", humanId: "h1", tenantId: "alpha" });
    const after = await pricer.quote("0xdead");
    expect(hbarFromTinybars(before.tinybars)).to.equal("0.005");
    expect(hbarFromTinybars(after.tinybars)).to.equal("0.01");
    // A venue nobody reported is untouched.
    expect(hbarFromTinybars((await pricer.quote("quaestor-dex")).tinybars)).to.equal("0.005");
  });

  it("normalizes the venue before counting", async () => {
    const feed = new MemoryThreatFeed();
    const pricer = createPermitPricer({ feed });
    await feed.report({ venue: "0xDEAD", pattern: "rug", humanId: "h1", tenantId: "a" });
    expect(await pricer.reporters("  0xdead ")).to.equal(1);
  });

  it("k can only tighten", () => {
    const pricer = createPermitPricer({ feed: new MemoryThreatFeed(), k: 1 });
    expect(pricer.tighten(2.5)).to.equal(2.5);
    expect(pricer.tighten(0.5)).to.equal(2.5); // lower: ignored
    expect(pricer.tighten(2.5)).to.equal(2.5); // equal: ignored
    expect(pricer.tighten(Number.NaN)).to.equal(2.5);
    expect(pricer.k()).to.equal(2.5);
    expect(() => createPermitPricer({ feed: new MemoryThreatFeed(), k: -1 })).to.throw(/PERMIT_K/);
  });
});
