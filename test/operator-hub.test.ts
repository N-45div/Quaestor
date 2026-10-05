import { expect } from "chai";
import { ethers } from "hardhat";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Store, migrate, type Sql } from "../operator/db";
import { KeySender } from "../operator/chain";
import { claimCode } from "../operator/agent";
import type { Brief, Decider, Screen, Verdict } from "../operator/decide";
import { proofHashOf, type Evidence } from "../operator/verify";
import type { OpNetwork } from "../operator/networks";
import { mountOperator, operatorFor, ownerMessage, type OperatorLane } from "../services/operator";

/**
 * The Operator over HTTP, against a real payout governor: an owner registers a project by
 * signing with the governor's owner wallet, a stranger applies, the operator offers, the payee
 * accepts with a signed route to another chain, delivers, and is paid, and anyone can fetch the
 * record behind the payment and re-hash it. Claude and the web are stubbed.
 */
describe("operator hub", () => {
  const USDC = (n: number) => BigInt(Math.round(n * 1e6));
  let server: Server | null = null;
  afterEach(() => server?.close());

  async function setup() {
    const [owner, payee, stranger] = await ethers.getSigners();
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

    const network: OpNetwork = {
      key: "hardhat", name: "Hardhat", chainId: 31337, rpcUrl: "", usdc: await token.getAddress(), factory: await factory.getAddress(),
      tokenMessenger: null, iris: "", explorer: "http://explorer.local", testnet: true, circleChain: "",
    };
    const lanes = new Map<string, OperatorLane>([["hardhat", { network, provider: ethers.provider, sender: new KeySender(operatorWallet) }]]);
    const { PGlite } = await import("@electric-sql/pglite");
    const sql = new PGlite() as unknown as Sql;
    await migrate(sql);
    const store = new Store(sql);

    const web = new Map<string, Partial<Evidence>>();
    const evidence = async (url: string): Promise<Evidence> => ({ ok: true, kind: "x-post", url, canonical: url, proofHash: proofHashOf(url), publishedAt: new Date(clock).toISOString(), ...web.get(url) });
    const clock = (await ethers.provider.getBlock("latest"))!.timestamp * 1000;
    const decider: Decider = {
      screen: async (): Promise<Screen> => ({
        decision: "offer", fit_score: 77, reasoning: "Their samples reach builders who run agents.", rate_usd: 9, deadline_days: 5, red_flags: [], owner_question: "",
        milestones: [{ title: "The post", share: 1, criteria: "A public post on X about Quaestor" }],
      }),
      verify: async (): Promise<Verdict> => ({ decision: "pay", pay_fraction: 1, quality: 5, reasoning: "Specific, accurate and on-brief.", issues: [], owner_question: "" }),
      brief: async (): Promise<Brief> => ({ headline: "One paid post", summary: "s", highlights: [], concerns: [], recommendations: [] }),
    };
    const operator = operatorFor(store, decider, lanes, { evidence, now: () => new Date(clock) });

    const app = express();
    mountOperator(app, { store, operator, lanes, deciding: true });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/operator`;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const signed = async (signer: { address: string; signMessage(m: string): Promise<string> }, projectId: string) => {
      const expires = Math.floor(Date.now() / 1000) + 3600;
      return { "x-owner-address": signer.address, "x-owner-expires": String(expires), "x-owner-signature": await signer.signMessage(ownerMessage(projectId, expires)) };
    };
    return { owner, payee, stranger, token, governor, operatorWallet, call, signed, web };
  }

  const project = (governor: string) => ({
    id: "quaestor", name: "Quaestor", network: "hardhat", governor, links: ["https://github.com/N-45div/Quaestor"],
    brief: "Quaestor gives AI agents budgets they cannot overspend, enforced by a contract. We want builders who run agents to hear about it.",
    tasks: [{ id: "post", kind: "x-post", title: "A post about Quaestor", done_when: "A public post on X that explains what Quaestor does", rate_min_usd: 5, rate_max_usd: 15, slots: 3 }],
  });

  it("registers a project only for the governor's owner, and only when the governor names this operator", async () => {
    const { stranger, owner, governor, token, call, signed } = await setup();
    const notAGovernor = await call("POST", "/projects", project(await token.getAddress()), await signed(owner, "quaestor"));
    expect(notAGovernor.body.error.code).to.equal("WRONG_OPERATOR");
    expect((await call("POST", "/projects", project(governor), await signed(stranger, "quaestor"))).status).to.equal(403);
    expect((await call("POST", "/projects", project(governor))).status).to.equal(401);
    const created = await call("POST", "/projects", project(governor), await signed(owner, "quaestor"));
    expect(created.status).to.equal(201);
    const page = await call("GET", "/projects/quaestor");
    expect(page.body.tasks).to.deep.equal([{ id: "quaestor-post", kind: "x-post", title: "A post about Quaestor", done_when: "A public post on X that explains what Quaestor does", rate_min_usd: 5, rate_max_usd: 15, slots: 3, slots_left: 3, open: true }]);
    expect(page.body.budget).to.include({ free_usd: 100, per_deal_cap_usd: 20, suspended: false });
    expect((await call("GET", "/projects/quaestor/owner")).status).to.equal(401);
    expect((await call("GET", "/projects/quaestor/owner", undefined, await signed(owner, "quaestor"))).body.budget.free_usd).to.equal(100);
  });

  it("takes an application, offers, accepts with a signed route to another chain, and pays the delivery with its record public", async () => {
    const { owner, payee, token, governor, call, signed, web } = await setup();
    await call("POST", "/projects", project(governor), await signed(owner, "quaestor"));
    expect((await call("POST", "/projects/quaestor/apply", { taskId: "quaestor-post", handle: "@builder", wallet: payee.address, pitch: "short" })).status).to.equal(400);
    const applied = await call("POST", "/projects/quaestor/apply", {
      taskId: "quaestor-post", handle: "@builder", wallet: payee.address, pitch: "I write about agent infrastructure for a few thousand builders.", samples: ["https://x.com/builder/status/1"],
    });
    expect(applied.status).to.equal(201);
    const me = `/me/${applied.body.token}`;
    expect((await call("GET", me)).body.application.status).to.equal("new");

    const ran = await call("POST", "/projects/quaestor/run", {}, await signed(owner, "quaestor"));
    expect(ran.body.notices[0].kind).to.equal("offer");
    const offer = (await call("GET", me)).body;
    expect(offer.application.reasoning).to.contain("builders who run agents");
    expect(offer.deal).to.include({ status: "offered", amount_usd: 9, claim_code: claimCode(offer.deal.id) });

    // The payee signs a route to Base for their payouts, and accepts with it.
    const typed = (await call("GET", `${me}/route?domain=6&recipient=${payee.address}`)).body;
    expect(typed.chain).to.equal("Base");
    const signature = await payee.signTypedData(typed.domain, typed.types, typed.message);
    const accepted = await call("POST", `${me}/accept`, { route: { domain: 6, recipient: payee.address, deadline: typed.message.deadline, signature } });
    expect(accepted.body.kind).to.equal("deal_open");
    expect((await call("GET", me)).body.route).to.deep.equal({ domain: 6, chain: "Base", recipient: payee.address.toLowerCase() });

    const post = "https://x.com/builder/status/42";
    web.set(post, { author: "builder", text: `Quaestor caps what an agent can spend, on-chain. ${offer.deal.claim_code}` });
    expect((await call("POST", `${me}/claim`, { milestone: 0, url: post })).status).to.equal(201);
    expect((await call("POST", `${me}/claim`, { milestone: 0, url: post })).status).to.equal(400);
    const paid = await call("POST", "/projects/quaestor/run", {}, await signed(owner, "quaestor"));
    expect(paid.body.notices.find((n: { kind: string }) => n.kind === "paid").detail).to.equal("$9 paid"); // no messenger here, so paid on this chain
    expect(await token.balanceOf(payee.address)).to.equal(USDC(9));

    const page = (await call("GET", "/projects/quaestor")).body;
    expect(page.totals).to.include({ paid_deliveries: 1, paid_usd: 9 });
    const [payment] = page.payments;
    expect(payment).to.include({ handle: "builder", proof_url: post, amount_usd: 9 });
    const record = (await call("GET", `/decisions/${payment.decision}`)).body;
    expect(ethers.keccak256(ethers.toUtf8Bytes(record.record))).to.equal(payment.decision);
    expect(record.parsed).to.include({ decision: "pay", proof: post });
    const screenHash = (await call("GET", "/projects/quaestor/owner", undefined, await signed(owner, "quaestor"))).body.decisions.find((d: { kind: string }) => d.kind === "screen").hash;
    expect((await call("GET", `/decisions/${screenHash}`)).status).to.equal(404); // a screening stays between the applicant and the owner
  });
});
