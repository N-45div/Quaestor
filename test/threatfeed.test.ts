import { expect } from "chai";
import { MemoryThreatFeed } from "../services/threatfeed";

const DAY = 24 * 60 * 60 * 1000;

describe("threat feed", () => {
  it("counts reporters per human, not per agent or per report", async () => {
    const feed = new MemoryThreatFeed();
    // Three agents, two of them backed by the same human.
    await feed.report({ venue: "0xDEAD", pattern: "honeypot", humanId: "h1", tenantId: "alpha" });
    await feed.report({ venue: "0xdead", pattern: "drain", humanId: "h1", tenantId: "alpha-2" });
    await feed.report({ venue: "0xDead", pattern: "honeypot", humanId: "h2", tenantId: "beta" });
    expect(await feed.distinctReporters("0xdead", DAY)).to.equal(2);
    expect((await feed.lookup("0xdead", DAY)).length).to.equal(3);
  });

  it("ignores unverified reports in the reporter count but keeps them in the log", async () => {
    const feed = new MemoryThreatFeed();
    await feed.report({ venue: "v", pattern: "other", humanId: "", tenantId: "anon" });
    expect(await feed.distinctReporters("v", DAY)).to.equal(0);
    expect((await feed.lookup("v", DAY)).length).to.equal(1);
  });

  it("forgets reports outside the window", async () => {
    const feed = new MemoryThreatFeed();
    const old = new Date(Date.now() - 2 * DAY).toISOString();
    await feed.report({ venue: "v", pattern: "rug", humanId: "h1", tenantId: "a", observedAt: old });
    await feed.report({ venue: "v", pattern: "rug", humanId: "h2", tenantId: "b" });
    expect(await feed.distinctReporters("v", DAY)).to.equal(1);
    expect(await feed.distinctReporters("v", 3 * DAY)).to.equal(2);
  });

  it("reports the head: count, last time, distinct venues", async () => {
    const feed = new MemoryThreatFeed();
    expect(await feed.head()).to.deep.equal({ count: 0, lastAt: null, venues: 0 });
    await feed.report({ venue: "a", pattern: "rug", humanId: "h1", tenantId: "t" });
    await feed.report({ venue: "b", pattern: "rug", humanId: "h1", tenantId: "t" });
    const h = await feed.head();
    expect(h.count).to.equal(2);
    expect(h.venues).to.equal(2);
    expect(h.lastAt).to.be.a("string");
  });

  it("is add-only: there is no way to remove a report", () => {
    const feed = new MemoryThreatFeed() as unknown as Record<string, unknown>;
    for (const name of ["delete", "remove", "clear", "reset", "retract"]) {
      expect(feed[name], `${name} must not exist`).to.equal(undefined);
    }
  });
});
