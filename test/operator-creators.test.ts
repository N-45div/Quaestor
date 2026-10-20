import { expect } from "chai";
import { ethers } from "hardhat";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Store, migrate, type Sql } from "../operator/db";
import { CreatorBook, PROOF_DAYS, creatorInput, normalHandle } from "../operator/creators";
import type { Fetch } from "../operator/verify";
import { KeySender } from "../operator/chain";
import type { Decider } from "../operator/decide";
import type { OpNetwork } from "../operator/networks";
import { mountOperator, operatorFor, type OperatorLane } from "../services/operator";

/**
 * The creator book: one profile per creator, handles proven by publishing a one-time code from them, a
 * track record read from what was paid on-chain, and applying to a task from the profile. The web is
 * stubbed with the shapes X's oEmbed, YouTube's oEmbed and GitHub's gist API return.
 */
describe("operator creator book", () => {
  const NOW = new Date("2026-10-21T12:00:00Z");
  const WALLET = "0x1111111111111111111111111111111111111111";
  const web = new Map<string, { status?: number; body: unknown }>();
  const fetchFn: Fetch = async (url) => {
    const hit = web.get(url);
    return { ok: !!hit && (hit.status ?? 200) < 400, status: hit?.status ?? 404, json: async () => hit?.body, text: async () => JSON.stringify(hit?.body ?? "") };
  };
  const xPost = (handle: string, id: string, text: string, date = "October 20, 2026") => {
    const url = `https://x.com/${handle}/status/${id}`;
    web.set(`https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(url)}`, {
      body: { author_url: `https://twitter.com/${handle}`, html: `<blockquote><p>${text}</p>&mdash; Someone (@${handle}) <a href="${url}">${date}</a></blockquote>` },
    });
    return url;
  };

  async function fresh() {
    const { PGlite } = await import("@electric-sql/pglite");
    const sql = new PGlite() as unknown as Sql;
    await migrate(sql);
    return { sql, book: new CreatorBook(sql, fetchFn, () => NOW) };
  }
  afterEach(() => web.clear());

  it("reads handles from @names and profile links, and refuses what cannot be one", () => {
    expect(normalHandle("x", "@Divij_N")).to.equal("divij_n");
    expect(normalHandle("x", "https://x.com/divij_n/status/1")).to.equal("divij_n");
    expect(normalHandle("youtube", "https://www.youtube.com/@Some.Channel")).to.equal("some.channel");
    expect(normalHandle("github", "N-45div")).to.equal("n-45div");
    expect(normalHandle("x", "much_too_long_for_x")).to.equal(null);
    expect(normalHandle("github", "-bad")).to.equal(null);
  });

  it("checks a profile field by field, naming the one that is wrong", () => {
    const nets = ["mezo-testnet", "arc-testnet"];
    expect(creatorInput({ name: "A", wallet: WALLET }, nets, true)).to.deep.equal({ error: "name: 2 to 60 characters" });
    expect(creatorInput({ name: "Ada", wallet: "0x12" }, nets, true)).to.have.property("error").that.contains("wallet");
    expect(creatorInput({ name: "Ada", wallet: WALLET, kinds: ["dance"] }, nets, true)).to.have.property("error").that.contains("kinds");
    expect(creatorInput({ name: "Ada", wallet: WALLET, networks: ["solana"] }, nets, true)).to.have.property("error").that.contains("networks");
    expect(creatorInput({ name: "Ada", wallet: WALLET, samples: ["http://plain"] }, nets, true)).to.have.property("error").that.contains("https");
    const ok = creatorInput({ name: "Ada", wallet: WALLET, niches: ["Bitcoin", "bitcoin", "DeFi"], rate_min_usd: 5, rate_max_usd: 20, networks: ["mezo-testnet"] }, nets, true);
    expect(ok).to.deep.include({ name: "Ada", wallet: WALLET, niches: ["bitcoin", "defi"], networks: ["mezo-testnet"], rate_min: 5_000_000n, rate_max: 20_000_000n });
  });

  it("proves an X handle only with the creator's own fresh post carrying their code", async () => {
    const { book } = await fresh();
    const made = await book.create({ name: "Ada", wallet: WALLET }, { x: "@ada_btc" });
    if ("error" in made) throw new Error(made.error);
    const { creator, handles } = made;
    const code = handles[0].code;
    expect(code).to.match(/^qc-[0-9a-f]{6}$/);

    const notHers = xPost("someone_else", "11", `my code ${code}`);
    expect(await book.verify(creator.id, "x", notHers)).to.deep.equal({ ok: false, error: "that was published by someone_else, not ada_btc" });
    const noCode = xPost("ada_btc", "12", "hello world");
    expect(await book.verify(creator.id, "x", noCode)).to.deep.equal({ ok: false, error: `it does not contain your code, ${code}` });
    const old = xPost("ada_btc", "13", `proving ${code}`, "September 1, 2026");
    expect(await book.verify(creator.id, "x", old)).to.deep.equal({ ok: false, error: `it is older than ${PROOF_DAYS} days; publish the code again` });
    expect(await book.verify(creator.id, "x", "https://x.com/ada_btc/status/99")).to.have.property("ok", false);

    const good = xPost("ada_btc", "14", `I make Bitcoin DeFi threads. Verifying for Quaestor: ${code}`);
    const out = await book.verify(creator.id, "x", good);
    expect(out.ok).to.equal(true);
    if (out.ok) expect(out.handle).to.include({ handle: "ada_btc", proof_url: good });
  });

  it("gives a handle to whoever proves it last, and withdraws the earlier claim", async () => {
    const { book } = await fresh();
    const a = await book.create({ name: "First", wallet: WALLET }, { x: "shared_one" });
    const b = await book.create({ name: "Second", wallet: "0x2222222222222222222222222222222222222222" }, { x: "shared_one" });
    if ("error" in a || "error" in b) throw new Error("create failed");
    expect((await book.verify(a.creator.id, "x", xPost("shared_one", "21", a.handles[0].code))).ok).to.equal(true);
    expect((await book.verify(b.creator.id, "x", xPost("shared_one", "22", b.handles[0].code))).ok).to.equal(true);
    expect((await book.handles(a.creator.id))[0].verified_at).to.equal(null);
    expect((await book.handles(b.creator.id))[0].verified_at).to.not.equal(null);
  });

  it("proves a GitHub handle with a public gist, and a YouTube handle with a video title", async () => {
    const { book } = await fresh();
    const made = await book.create({ name: "Dev", wallet: WALLET }, { github: "dev-person", youtube: "@devchannel" });
    if ("error" in made) throw new Error(made.error);
    const code = (p: string) => made.handles.find((h) => h.platform === p)!.code;
    web.set("https://api.github.com/gists/0123456789abcdef0123", { body: { owner: { login: "Dev-Person" }, description: "", created_at: "2026-10-20T10:00:00Z", files: { "proof.txt": { content: `quaestor ${code("github")}` } } } });
    expect(await book.verify(made.creator.id, "github", "https://github.com/dev-person")).to.have.property("ok", false);
    expect((await book.verify(made.creator.id, "github", "https://gist.github.com/dev-person/0123456789abcdef0123")).ok).to.equal(true);
    const video = "https://youtube.com/watch?v=abc123";
    web.set(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(video)}`, { body: { title: `Quaestor proof ${code("youtube")}`, author_url: "https://www.youtube.com/@DevChannel" } });
    expect((await book.verify(made.creator.id, "youtube", video)).ok).to.equal(true);
  });

  it("adds up what was paid to the wallet, across projects and chains", async () => {
    const { sql, book } = await fresh();
    const store = new Store(sql);
    for (const [pid, net] of [["p1", "mezo-testnet"], ["p2", "arc-testnet"]]) {
      await store.saveProject({ id: pid, name: pid.toUpperCase(), owner_address: WALLET, network: net, governor: null, brief: "b", links: [] });
      await store.saveTask({ id: `${pid}-t`, project_id: pid, kind: "article", title: "t", done_when: "a public article", rate_min: 1n, rate_max: 5_000_000n, slots: 3, open: true });
      await store.addApplicant({ id: `${pid}-a`, project_id: pid, task_id: `${pid}-t`, handle: "ada", wallet: WALLET, email: null, pitch: "p", samples: [], asked_rate: null, token: `${pid}-tok` });
      await store.saveDeal({ id: `${pid}-d`, project_id: pid, applicant_id: `${pid}-a`, payee: WALLET, amount: 2_500_000n, milestones: [], terms: "{}", terms_hash: "0x", deadline: NOW, status: "closed", access_token: `${pid}-acc`, chain_tx: null });
      await store.addClaim({ id: `${pid}-c`, deal_id: `${pid}-d`, milestone: 0, proof_url: `https://example.com/${pid}`, proof_hash: ethers.id(pid) });
      await store.settleClaim(`${pid}-c`, "paid", {}, 2_500_000n, `0x${pid === "p1" ? "a" : "b"}`.padEnd(66, "0"));
    }
    const r = await book.record(WALLET.toUpperCase().replace("0X", "0x"));
    expect(r).to.deep.include({ deliveries: 2, paid: 5_000_000n });
    expect(r.by_network["mezo-testnet"]).to.deep.equal({ deliveries: 1, paid: 2_500_000n });
    expect(r.recent).to.have.length(2);
  });

  describe("over HTTP", () => {
    let server: Server | null = null;
    afterEach(() => server?.close());

    async function hub() {
      const { sql, book } = await fresh();
      const store = new Store(sql);
      await store.saveProject({ id: "musd-co", name: "MUSD Co", owner_address: WALLET, network: "mezo-testnet", governor: null, brief: "A Bitcoin-backed payments app.", links: [] });
      await store.saveTask({ id: "musd-co-thread", project_id: "musd-co", kind: "thread", title: "A thread", done_when: "A thread on X about the app", rate_min: 1_000_000n, rate_max: 3_000_000n, slots: 3, open: true });
      await store.saveTask({ id: "musd-co-video", project_id: "musd-co", kind: "video", title: "A video", done_when: "A YouTube video about the app", rate_min: 2_000_000n, rate_max: 5_000_000n, slots: 3, open: true });
      const network = { key: "mezo-testnet", name: "Mezo testnet", chainId: 31611, rpcUrl: "", usdc: WALLET, tokenSymbol: "MUSD", tokenDecimals: 18, gasSymbol: "BTC", gasGrant: "0.0005", factory: WALLET, tokenMessenger: null, iris: "", explorer: "https://explorer.test.mezo.org", testnet: true, circleChain: "" } as OpNetwork;
      const lanes = new Map<string, OperatorLane>([["mezo-testnet", { network, provider: ethers.provider, sender: new KeySender(ethers.Wallet.createRandom()) }]]);
      const operator = operatorFor(store, {} as Decider, lanes);
      const app = express();
      mountOperator(app, { store, operator, lanes, deciding: false, creators: book });
      await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
      const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/operator`;
      return async (method: string, path: string, body?: unknown) => {
        const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: (await res.json()) as Record<string, any> };
      };
    }

    it("signs a creator up, proves their handle, lists them, and applies from the profile", async () => {
      const call = await hub();
      expect((await call("POST", "/creators", { name: "Ada", wallet: WALLET, networks: ["solana"] })).body.error.code).to.equal("INVALID_PROFILE");
      const made = await call("POST", "/creators", {
        name: "Ada", wallet: WALLET, bio: "I write threads that explain Bitcoin DeFi to people new to it.", niches: ["bitcoin", "defi"], kinds: ["thread"],
        samples: ["https://x.com/ada_btc/status/1"], rate_min_usd: 1, rate_max_usd: 3, networks: ["mezo-testnet"], handles: { x: "ada_btc" },
      });
      expect(made.status).to.equal(201);
      const { token, id } = made.body;
      const code = made.body.handles[0].code;
      expect(made.body.handles[0]).to.include({ platform: "x", handle: "ada_btc", proven: false });

      // Not listed until a handle is proven, and a platform task needs that platform proven.
      expect((await call("GET", "/creators")).body.creators).to.have.length(0);
      expect((await call("GET", `/creators/${id}`)).status).to.equal(404);
      expect((await call("POST", `/creators/me/${token}/apply`, { taskId: "musd-co-thread" })).body.error.code).to.equal("UNPROVEN_HANDLE");

      expect((await call("POST", `/creators/me/${token}/verify`, { platform: "x", url: xPost("ada_btc", "31", "no code here") })).status).to.equal(422);
      const proven = await call("POST", `/creators/me/${token}/verify`, { platform: "x", url: xPost("ada_btc", "32", `Verifying ${code}`) });
      expect(proven.body).to.include({ proven: true });

      const listed = (await call("GET", "/creators?niche=bitcoin")).body.creators;
      expect(listed.map((c: { name: string }) => c.name)).to.deep.equal(["Ada"]);
      expect(listed[0]).to.not.have.property("email");
      expect(listed[0].handles[0]).to.not.have.property("code");
      expect((await call("GET", "/creators?niche=gaming")).body.creators).to.have.length(0);
      expect((await call("GET", `/creators/${id}`)).body.record).to.include({ deliveries: 0, paid_usd: 0 });

      expect((await call("POST", `/creators/me/${token}/apply`, { taskId: "musd-co-video" })).body.error.message).to.contain("youtube");
      const applied = await call("POST", `/creators/me/${token}/apply`, { taskId: "musd-co-thread" });
      expect(applied.status).to.equal(201);
      expect(applied.body).to.include({ project: "musd-co", handle: "ada_btc" });
      const me = await call("GET", `/me/${applied.body.token}`);
      expect(me.body.application).to.include({ handle: "ada_btc", wallet: WALLET });
      expect((await call("POST", `/creators/me/${token}/apply`, { taskId: "musd-co-thread" })).body.error.message).to.contain("already applied");
    });
  });
});
