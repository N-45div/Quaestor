import { expect } from "chai";
import { Store, migrate, type Sql } from "../operator/db";

/**
 * The Operator's records on an in-memory Postgres (PGlite): the schema migrates twice cleanly,
 * a proof can be claimed once, decisions and track records add up, and heads-ups open and close.
 */
describe("operator store", () => {
  async function fresh(): Promise<Store> {
    const { PGlite } = await import("@electric-sql/pglite");
    const sql = new PGlite() as unknown as Sql;
    await migrate(sql);
    await migrate(sql); // twice: every statement is idempotent
    const s = new Store(sql);
    await s.saveProject({ id: "quaestor", name: "Quaestor", owner_address: "0xD486faaa06a5630Ab1c61519011584df5F07e7DD", network: "arc-testnet", governor: null, brief: "Agents with allowances", links: ["https://github.com/N-45div/Quaestor"] });
    await s.saveTask({ id: "t-post", project_id: "quaestor", kind: "x-post", title: "A post about Quaestor", done_when: "A public post on X linking the repo", rate_min: 5_000_000n, rate_max: 20_000_000n, slots: 5, open: true });
    return s;
  }

  it("keeps projects, tasks with their rate bands, and applicants", async () => {
    const s = await fresh();
    const [task] = await s.tasks("quaestor");
    expect([task.rate_min, task.rate_max]).to.deep.equal([5_000_000n, 20_000_000n]);
    await s.addApplicant({ id: "a1", project_id: "quaestor", task_id: "t-post", handle: "@writer", wallet: "0xAbC0000000000000000000000000000000000001", email: null, pitch: "I write about agents", samples: ["https://x.com/writer/status/1"], asked_rate: 12_000_000n });
    const [a] = await s.applicants("quaestor", "new");
    expect(a.wallet).to.equal("0xabc0000000000000000000000000000000000001");
    expect(a.asked_rate).to.equal(12_000_000n);
    await s.setApplicant("a1", "offered", 82);
    expect((await s.applicant("a1"))!.score).to.equal(82);
    expect(await s.applicants("quaestor", "new")).to.have.length(0);
  });

  it("refuses a second claim on the same proof", async () => {
    const s = await fresh();
    await s.addApplicant({ id: "a1", project_id: "quaestor", task_id: "t-post", handle: "@w", wallet: "0x0000000000000000000000000000000000000001", email: null, pitch: "p", samples: [], asked_rate: null });
    await s.saveDeal({ id: "0xd1", project_id: "quaestor", applicant_id: "a1", payee: "0x0000000000000000000000000000000000000001", amount: 10_000_000n, milestones: [{ title: "Post", amount: "10000000", criteria: "live" }], terms: "{}", terms_hash: "0x00", deadline: new Date(Date.now() + 86_400_000), status: "open", access_token: "tok", chain_tx: null });
    expect(await s.addClaim({ id: "c1", deal_id: "0xd1", milestone: 0, proof_url: "https://x.com/w/status/9", proof_hash: "0xp" })).to.equal(true);
    expect(await s.addClaim({ id: "c2", deal_id: "0xd1", milestone: 0, proof_url: "https://x.com/w/status/9", proof_hash: "0xp" })).to.equal(false);
    expect((await s.dealByToken("tok"))!.amount).to.equal(10_000_000n);
    expect(await s.openClaims("quaestor")).to.have.length(1);
    await s.settleClaim("c1", "paid", { ok: true }, 10_000_000n, "0xtx");
    expect(await s.openClaims("quaestor")).to.have.length(0);
  });

  it("adds up a payee's track record, and opens and closes heads-ups", async () => {
    const s = await fresh();
    await s.bumpReputation("quaestor", "0xAA", { delivered: 1, paid: 10_000_000n, quality: 4 });
    await s.bumpReputation("quaestor", "0xaa", { delivered: 1, late: 1, paid: 5_000_000n, quality: 2 });
    const r = await s.reputation("quaestor", "0xAa");
    expect(r).to.deep.equal({ delivered: 2, late: 1, rejected: 0, paid: 15_000_000n, quality: 3 });
    await s.headsUp({ id: "h1", project_id: "quaestor", kind: "approve", subject: "0xd1", text: "Quick check: approve a $40 deal?" });
    expect(await s.headsUps("quaestor")).to.have.length(1);
    await s.closeHeadsUp("h1", "done");
    expect(await s.headsUps("quaestor")).to.have.length(0);
  });
});
