import { expect } from "chai";
import { ethers } from "hardhat";
import { Store, migrate, type Sql } from "../operator/db";
import { GovernorClient, KeySender } from "../operator/chain";
import { DecisionUnavailable, type Brief, type BriefInput, type Decider, type Screen, type ScreenInput, type Verdict, type VerifyInput } from "../operator/decide";
import { Operator, OFFER_DAYS, claimCode } from "../operator/agent";
import { proofHashOf, type Evidence } from "../operator/verify";

/**
 * The Operator's whole loop against a real payout governor, with Claude and the web stubbed:
 * an application becomes an offer, an acceptance escrows it on-chain, a delivery carrying the
 * deal's code is paid with the decision's hash on-chain, failed facts are refused without asking
 * the model, a deal over the operator's limits waits for the owner, and lapsed money comes back.
 */
describe("operator agent", () => {
  const USDC = (n: number) => BigInt(Math.round(n * 1e6));

  class FakeDecider implements Decider {
    rate = 8;
    unavailable = false;
    verdict: Verdict = { decision: "pay", pay_fraction: 1, quality: 4, reasoning: "Clear, accurate post that links the repo.", issues: [], owner_question: "" };
    screens: ScreenInput[] = [];
    verifies: VerifyInput[] = [];
    briefs: BriefInput[] = [];

    async screen(input: ScreenInput): Promise<Screen> {
      this.screens.push(input);
      if (this.unavailable) throw new DecisionUnavailable("the model declined (test)");
      return {
        decision: "offer", fit_score: 81, reasoning: "Writes about agent wallets for the right audience.", rate_usd: this.rate, deadline_days: 3,
        red_flags: [], owner_question: "", milestones: [{ title: "The post", share: 1, criteria: "A public post on X linking the repo" }],
      };
    }
    async verify(input: VerifyInput): Promise<Verdict> {
      this.verifies.push(input);
      return this.verdict;
    }
    async brief(input: BriefInput): Promise<Brief> {
      this.briefs.push(input);
      return { headline: "One post bought, on time", summary: "A single writer delivered.", highlights: [], concerns: [], recommendations: [] };
    }
  }

  async function setup() {
    const [owner, payeeA, payeeB] = await ethers.getSigners();
    const operatorWallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await owner.sendTransaction({ to: operatorWallet.address, value: ethers.parseEther("1") });
    const token = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    await token.mint(owner.address, USDC(100));
    const factory = await (await ethers.getContractFactory("QuaestorPayouts")).deploy();
    await token.approve(await factory.getAddress(), USDC(100));
    const s = {
      operator: operatorWallet.address, token: await token.getAddress(), epochLength: 30 * 86_400, perDealCap: USDC(20), epochCap: USDC(50),
      newPayeeCap: USDC(10), newPayeesPerEpoch: 3, payees: [], payeeCaps: [], tokenMessenger: ethers.ZeroAddress, maxForwardFeeBps: 0, deposit: USDC(100),
    };
    const governor = await factory.createGovernor.staticCall(s);
    await factory.createGovernor(s);
    const gov = new GovernorClient(governor, ethers.provider, new KeySender(operatorWallet));

    const { PGlite } = await import("@electric-sql/pglite");
    const sql = new PGlite() as unknown as Sql;
    await migrate(sql);
    const store = new Store(sql);
    await store.saveProject({ id: "quaestor", name: "Quaestor", owner_address: owner.address, network: "hardhat", governor, brief: "Spending limits for AI agents, enforced on-chain.", links: [] });
    await store.saveTask({ id: "t-post", project_id: "quaestor", kind: "x-post", title: "A post about Quaestor", done_when: "A public post on X linking the repo", rate_min: USDC(5), rate_max: USDC(20), slots: 5, open: true });

    // The Operator runs on the chain's clock: other suites move it ahead of the wall clock.
    let clock = (await ethers.provider.getBlock("latest"))!.timestamp * 1000;
    const advance = async (days: number) => {
      await ethers.provider.send("evm_increaseTime", [days * 86_400]);
      await ethers.provider.send("evm_mine", []);
      clock = (await ethers.provider.getBlock("latest"))!.timestamp * 1000;
    };
    const web = new Map<string, Partial<Evidence>>();
    const evidence = async (url: string): Promise<Evidence> => {
      const canonical = url.replace("twitter.com", "x.com");
      return { ok: true, kind: "x-post", url, canonical, proofHash: proofHashOf(url), publishedAt: new Date(clock).toISOString(), ...web.get(url) };
    };
    const decider = new FakeDecider();
    const operator = new Operator({ store, decider, governorFor: () => gov, evidence, now: () => new Date(clock) });
    const project = (await store.project("quaestor"))!;
    return { owner, payeeA, payeeB, token, gov, store, decider, operator, project, web, advance };
  }

  async function offered(ctx: Awaited<ReturnType<typeof setup>>, payee: { address: string }, handle: string) {
    const applied = await ctx.operator.apply("quaestor", { taskId: "t-post", handle: `@${handle}`, wallet: payee.address, pitch: "I write about agent wallets.", samples: ["https://x.com/" + handle + "/status/1"] });
    if ("error" in applied) throw new Error(applied.error);
    const [notice] = await ctx.operator.screenNew(ctx.project);
    expect(notice.kind).to.equal("offer");
    return { token: applied.token, dealId: notice.subject };
  }

  it("turns an application into an offer, escrows it on acceptance, and pays a delivery that carries the deal's code", async () => {
    const ctx = await setup();
    const { token, dealId } = await offered(ctx, ctx.payeeA, "writer");
    expect(ctx.decider.screens[0].budget.free_usd).to.equal(100);
    expect((await ctx.store.deal(dealId))!.status).to.equal("offered");

    const opened = await ctx.operator.accept(token);
    expect(opened.kind).to.equal("deal_open");
    expect((await ctx.gov.deal(dealId)).state).to.equal("open");
    expect((await ctx.gov.limits()).committed).to.equal(USDC(8));

    const post = "https://x.com/writer/status/777";
    ctx.web.set(post, { author: "writer", text: `Quaestor gives agents a budget they cannot overspend. ${claimCode(dealId)} #ad` });
    expect(await ctx.operator.claim(token, 0, post)).to.have.property("id");
    const notices = await ctx.operator.tick();
    const paid = notices.find((n) => n.kind === "paid")!;
    expect(paid.detail).to.equal("$8 paid");
    expect(await ctx.token.balanceOf(ctx.payeeA.address)).to.equal(USDC(8));
    expect((await ctx.store.deal(dealId))!.status).to.equal("closed");
    expect(await ctx.store.reputation("quaestor", ctx.payeeA.address)).to.include({ delivered: 1, rejected: 0, quality: 4 });

    // The decision behind the payment is on-chain as a hash, and its record re-hashes to it.
    const verify = (await ctx.store.decisions("quaestor")).find((d) => d.kind === "verify")!;
    expect(ethers.keccak256(ethers.toUtf8Bytes(verify.record))).to.equal(verify.hash);
    const receipt = (await ethers.provider.getTransactionReceipt(paid.tx!))!;
    expect(receipt.logs.some((l) => l.data.includes(verify.hash.slice(2)) || l.topics.includes(verify.hash))).to.equal(true);

    // The brief covers it, and lands as a heads-up for the owner.
    expect(notices.some((n) => n.kind === "brief")).to.equal(true);
    expect(ctx.decider.briefs[0].stats).to.include({ applications: 1, deliveries_paid: 1, paid_usd: 8 });
    expect(ctx.decider.briefs[0].payees[0]).to.include({ handle: "writer", delivered: 1 });
    expect((await ctx.store.headsUps("quaestor")).some((h) => h.kind === "brief")).to.equal(true);
  });

  it("refuses a delivery by someone else or without the code, without asking the model, and takes the fixed link again", async () => {
    const ctx = await setup();
    const { token, dealId } = await offered(ctx, ctx.payeeA, "writer");
    await ctx.operator.accept(token);

    const theirs = "https://x.com/famous/status/1";
    ctx.web.set(theirs, { author: "famous", text: `Quaestor is great ${claimCode(dealId)} #ad` });
    await ctx.operator.claim(token, 0, theirs);
    const noCode = "https://x.com/writer/status/2";
    ctx.web.set(noCode, { author: "writer", text: "Quaestor is great #ad" });
    let [refused] = await ctx.operator.judgeClaims(ctx.project);
    expect(refused).to.include({ kind: "claim_rejected" });
    expect(refused.detail).to.contain("published by famous, not writer");
    expect(await ctx.operator.claim(token, 0, noCode)).to.have.property("id");
    [refused] = await ctx.operator.judgeClaims(ctx.project);
    expect(refused.detail).to.contain(`does not mention ${claimCode(dealId)}`);
    expect(ctx.decider.verifies).to.have.length(0);
    expect(await ctx.token.balanceOf(ctx.payeeA.address)).to.equal(0n);

    // A rejected link is free again: once it carries the code, it is judged and paid.
    ctx.web.set(noCode, { author: "writer", text: `Quaestor is great ${claimCode(dealId)} #ad` });
    expect(await ctx.operator.claim(token, 0, noCode)).to.have.property("id");
    const [paid] = await ctx.operator.judgeClaims(ctx.project);
    expect(paid.kind).to.equal("paid");
    expect(await ctx.operator.claim(token, 0, "https://x.com/writer/status/3")).to.deep.equal({ error: "this deal is not open" });
  });

  it("holds an offer outside the band for the owner, and a deal over the operator's limits until the owner approves", async () => {
    const ctx = await setup();
    ctx.decider.rate = 45;
    await ctx.operator.apply("quaestor", { taskId: "t-post", handle: "pricey", wallet: ctx.payeeB.address, pitch: "p", samples: [] });
    const [held] = await ctx.operator.screenNew(ctx.project);
    expect(held.kind).to.equal("escalated");
    expect(held.detail).to.contain("$45").and.contain("$5-$20");

    ctx.decider.rate = 15; // inside the band and the deal cap, over what a new payee may get unapproved
    const { token, dealId } = await offered(ctx, ctx.payeeA, "writer");
    const pending = await ctx.operator.accept(token);
    expect(pending.kind).to.equal("deal_pending");
    expect((await ctx.store.headsUps("quaestor")).map((h) => h.kind)).to.include("approve_deal");

    await (ctx.gov.contract.connect(ctx.owner) as typeof ctx.gov.contract).approveDeal(dealId);
    await ctx.operator.syncPending(ctx.project);
    expect((await ctx.store.deal(dealId))!.status).to.equal("open");
    expect((await ctx.store.headsUps("quaestor")).map((h) => h.kind)).to.not.include("approve_deal");
  });

  it("lapses an offer nobody accepted and escrow past its deadline, and the budget is free again", async () => {
    const ctx = await setup();
    const a = await offered(ctx, ctx.payeeA, "writer");
    await ctx.operator.accept(a.token);
    const b = await offered(ctx, ctx.payeeB, "slow");
    expect((await ctx.gov.limits()).freeBalance).to.equal(USDC(92));

    await ctx.advance(OFFER_DAYS + 1); // past the offer window, and past the 3-day deadline plus its grace
    const lapsed = await ctx.operator.lapse(ctx.project);
    expect(lapsed.map((n) => n.subject).sort()).to.deep.equal([a.dealId, b.dealId].sort());
    expect((await ctx.store.deal(a.dealId))!.status).to.equal("expired");
    expect((await ctx.gov.deal(a.dealId)).state).to.equal("cancelled");
    expect((await ctx.gov.limits()).freeBalance).to.equal(USDC(100));
    expect((await ctx.operator.accept(b.token)).kind).to.equal("error");
  });

  it("pays what the owner decides on a delivery the Operator held back, with the owner's decision on record", async () => {
    const ctx = await setup();
    const { token, dealId } = await offered(ctx, ctx.payeeA, "writer");
    await ctx.operator.accept(token);
    const post = "https://x.com/writer/status/9";
    ctx.web.set(post, { author: "writer", text: `A thread on Quaestor ${claimCode(dealId)} #ad` });
    await ctx.operator.claim(token, 0, post);
    ctx.decider.verdict = { decision: "ask_owner", pay_fraction: 0, quality: 3, reasoning: "Half the thread is about another project.", issues: [], owner_question: "Pay half?" };
    const [held] = await ctx.operator.judgeClaims(ctx.project);
    expect(held).to.include({ kind: "claim_escalated", detail: "Pay half?" });
    const [claim] = await ctx.store.projectClaims("quaestor");
    expect((await ctx.operator.ownerJudge(ctx.project, ctx.owner.address, claim.id, 0.5)).detail).to.equal("$4 paid");
    expect(await ctx.token.balanceOf(ctx.payeeA.address)).to.equal(USDC(4));
    const record = JSON.parse((await ctx.store.lastDecision("quaestor", "owner_verify", claim.id))!.record);
    expect(record).to.include({ by: ctx.owner.address.toLowerCase(), pay_fraction: 0.5 });
    expect((await ctx.store.headsUps("quaestor")).map((h) => h.kind)).to.not.include("claim");
    expect((await ctx.operator.ownerJudge(ctx.project, ctx.owner.address, claim.id, 1)).kind).to.equal("error"); // settled once
  });

  it("hands the owner a question when the model cannot decide, and takes one application per wallet", async () => {
    const ctx = await setup();
    ctx.decider.unavailable = true;
    const first = await ctx.operator.apply("quaestor", { taskId: "t-post", handle: "writer", wallet: ctx.payeeA.address, pitch: "p", samples: [] });
    expect(first).to.have.property("token");
    expect(await ctx.operator.apply("quaestor", { taskId: "t-post", handle: "writer", wallet: ctx.payeeA.address, pitch: "again", samples: [] }))
      .to.deep.equal({ error: "you have already applied for this task" });
    const [n] = await ctx.operator.screenNew(ctx.project);
    expect(n.kind).to.equal("escalated");
    expect((await ctx.store.headsUps("quaestor"))[0].text).to.contain("couldn't decide on @writer");
    expect((await ctx.store.applicants("quaestor"))[0].status).to.equal("escalated");
  });
});
