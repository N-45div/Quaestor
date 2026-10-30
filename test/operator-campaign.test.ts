import { expect } from "chai";
import { ethers } from "hardhat";
import { Store, migrate, type Sql } from "../operator/db";
import { CreatorBook } from "../operator/creators";
import { KeySender, settle } from "../operator/chain";
import { campaignPlan, openGovernorFor } from "../operator/campaign";
import { OperatorChat, type ChatMessage, type ChatModel, type ModelTurn, type ToolCall } from "../operator/chat";
import type { OpNetwork } from "../operator/networks";
import { budgetOf, openCampaign, type OperatorLane } from "../services/operator";

/**
 * A campaign opened from the chat with no wallet connected: the operator's key opens a payout governor through the
 * real factory, owned by the address the business named; a plain transfer funds it, the hub then opens its tasks,
 * and the operator still cannot take the money out. The model is scripted; the chain is Hardhat's.
 */
type Step = (msgs: ChatMessage[]) => { text?: string; calls?: Omit<ToolCall, "id">[] };
class Script implements ChatModel {
  readonly name = "script";
  private n = 0;
  /** How many tools each turn was offered. */
  offered: number[] = [];
  constructor(private readonly steps: Step[]) {}
  async turn(messages: ChatMessage[], tools: unknown[] = []): Promise<ModelTurn> {
    this.offered.push(tools.length);
    const step = this.steps.shift();
    if (!step) throw new Error("the script ran out");
    const out = step(messages);
    const calls = (out.calls ?? []).map((c, i) => ({ ...c, id: `call-${++this.n}-${i}` }));
    return { text: out.text ?? "", calls, message: { role: "assistant", content: out.text ?? null, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } };
  }
}
const lastTool = (msgs: ChatMessage[]) => JSON.parse(String([...msgs].reverse().find((m) => m.role === "tool")?.content ?? "{}"));

describe("operator campaign from the chat", () => {
  const MUSD = (n: number) => ethers.parseUnits(String(n), 18);

  async function setup(steps: Step[]) {
    const [operatorKey, business, funder] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockERC20")).deploy("Mezo USD", "MUSD", 18);
    const factory = await (await ethers.getContractFactory("QuaestorPayouts")).deploy(0);
    const network: OpNetwork = {
      key: "mezo-testnet", name: "Mezo testnet", chainId: 31337, rpcUrl: "", usdc: await token.getAddress(), tokenSymbol: "MUSD", tokenDecimals: 18,
      gasSymbol: "BTC", gasGrant: "0", factory: await factory.getAddress(), tokenMessenger: null, iris: "", explorer: "https://explorer.test.mezo.org", testnet: true, circleChain: "",
    };
    const lanes = new Map<string, OperatorLane>([["mezo-testnet", { network, provider: ethers.provider, sender: new KeySender(operatorKey) }]]);
    const { PGlite } = await import("@electric-sql/pglite");
    const sql = new PGlite() as unknown as Sql;
    await migrate(sql);
    const store = new Store(sql);
    const chat = new OperatorChat({
      sql, store, book: new CreatorBook(sql), model: new Script(steps), networks: [{ key: "mezo-testnet", name: "Mezo testnet", token: "MUSD" }],
      apply: async () => ({ error: "not in this test" }),
      campaigns: { open: (d, owner) => openCampaign(store, lanes, d, owner), budget: (pid) => budgetOf(store, lanes, pid) },
    });
    return { chat, store, token, operatorKey, business, funder, lanes, factory };
  }

  const draft = {
    name: "Savings app", brief: "A Bitcoin savings app on Mezo, for BTC holders who want to borrow MUSD instead of selling their coins.",
    tasks: [
      { kind: "x-post", title: "A post", done_when: "A public post explaining the borrow flow", rate_min_usd: 2, rate_max_usd: 5, slots: 2 },
      { kind: "thread", title: "A thread", done_when: "A thread on X walking through a first loan", rate_min_usd: 5, rate_max_usd: 10, slots: 1 },
    ],
  };

  it("opens a governor owned by the business's address, waits for a plain transfer, then opens the tasks", async () => {
    let governor = "";
    const { chat, store, token, operatorKey, business, funder } = await setup([
      () => ({ calls: [{ name: "draft_project", args: draft }] }),
      () => ({ text: "Here is the draft. Which address should own it?" }),
      // An address that is not one, then the operator's own: both refused before any transaction.
      () => ({ calls: [{ name: "open_campaign", args: { owner_address: "my wallet" } }] }),
      (msgs) => {
        expect(lastTool(msgs).error).to.contain("0x");
        return { calls: [{ name: "open_campaign", args: { owner_address: operatorKey.address } }] };
      },
      (msgs) => {
        expect(lastTool(msgs).error).to.contain("not the operator's");
        return { calls: [{ name: "open_campaign", args: { owner_address: business.address } }] };
      },
      (msgs) => {
        const out = lastTool(msgs);
        expect(out).to.include({ opened: true, token: "MUSD", budget_usd: 20 });
        governor = out.deposit_address;
        return { text: `Send MUSD to ${governor}.` };
      },
      // Asked again, it hands back the same campaign rather than opening a second.
      () => ({ calls: [{ name: "open_campaign", args: { owner_address: business.address } }] }),
      (msgs) => {
        expect(lastTool(msgs)).to.include({ already_open: true, deposit_address: governor });
        return { calls: [{ name: "campaign_status", args: {} }] };
      },
      (msgs) => {
        expect(lastTool(msgs)).to.include({ funded: false, arrived: 0 });
        return { text: "Nothing has arrived yet." };
      },
    ]);

    const first = await chat.say({ message: "I want posts about my Bitcoin savings app, 20 MUSD in all" });
    const opened = await chat.say({ message: "Open it; my address is below", token: first.token });
    const card = opened.cards.find((c) => c.type === "campaign") as { campaign: { governor: string; owner: string; project_id: string; operator: string } } | undefined;
    expect(card?.campaign).to.include({ governor, owner: business.address, operator: operatorKey.address });
    const pid = card!.campaign.project_id;
    expect(pid).to.equal("savings-app");
    await chat.say({ message: "Open it again", token: first.token });

    // On-chain: the business owns it, the hub's key operates it, and it holds nothing yet.
    const gov = await ethers.getContractAt("QuaestorPayoutGovernor", governor);
    expect(await gov.owner()).to.equal(business.address);
    expect(await gov.operator()).to.equal(operatorKey.address);
    expect(await gov.perDealCap()).to.equal(MUSD(10));
    expect(await gov.epochCap()).to.equal(MUSD(20));
    // Registered with its tasks closed until the budget arrives.
    const tasks = await store.tasks(pid);
    expect(tasks.map((t) => [t.id, t.open])).to.deep.equal([["savings-app-a-post", false], ["savings-app-a-thread", false]]);
    expect(await chat.watchFunding()).to.deep.equal([]);

    // Less than the most one task pays is not funded yet; the rest, from another wallet, is.
    await token.mint(funder.address, MUSD(20));
    await token.connect(funder).transfer(governor, MUSD(3));
    expect(await chat.watchFunding()).to.deep.equal([]);
    await token.connect(funder).transfer(governor, MUSD(17));
    expect(await chat.watchFunding()).to.deep.equal([pid]);
    expect((await store.tasks(pid)).every((t) => t.open)).to.equal(true);
    expect(await chat.watchFunding()).to.deep.equal([]); // once
    const log = (await chat.transcript(first.token))!.log;
    expect(log.at(-1)!.text).to.contain("Your budget arrived: 20 MUSD");

    // The operator's key, the funder and anyone else cannot take it back; the business can.
    for (const who of [operatorKey, funder]) await expect(gov.connect(who).withdraw(who.address, 1n)).to.be.revertedWithCustomError(gov, "NotOwner");
    await gov.connect(business).withdraw(business.address, MUSD(1));
    expect(await token.balanceOf(business.address)).to.equal(MUSD(1));
  });

  it("uses the governor a try that looked failed already opened, rather than opening a second", async () => {
    const { chat, lanes, business, factory } = await setup([
      () => ({ calls: [{ name: "draft_project", args: draft }] }),
      () => ({ text: "Drafted." }),
      () => ({ calls: [{ name: "open_campaign", args: { owner_address: business.address } }] }),
      () => ({ text: "Open." }),
    ]);
    const first = await chat.say({ message: "Posts about my savings app, 20 MUSD in all" });
    // The earlier try: it landed, but the hub never saw the receipt, so no project claims it.
    const lane = lanes.get("mezo-testnet")!;
    const earlier = await openGovernorFor(lane, business.address, campaignPlan(draft.tasks));
    const opened = await chat.say({ message: `Open it for ${business.address}`, token: first.token });
    const card = opened.cards.find((c) => c.type === "campaign") as unknown as { campaign: { governor: string; tx_url: string } };
    expect(card.campaign.governor).to.equal(earlier.governor);
    expect(card.campaign.tx_url).to.equal("");
    expect(await factory.governorsOf(business.address)).to.deep.equal([earlier.governor]);
  });

  it("opens a fresh campaign for an owner who already has others", async () => {
    const { chat, lanes, business, factory } = await setup([
      () => ({ calls: [{ name: "draft_project", args: draft }] }),
      () => ({ text: "Drafted." }),
      () => ({ calls: [{ name: "open_campaign", args: { owner_address: business.address } }] }),
      () => ({ text: "Open." }),
    ]);
    // Two earlier campaigns with other limits, so neither is reused.
    const lane = lanes.get("mezo-testnet")!;
    const other = { ...campaignPlan(draft.tasks), perDealUsd: 1, periodUsd: 2, newPayeeUsd: 1 };
    const earlier = [(await openGovernorFor(lane, business.address, other)).governor, (await openGovernorFor(lane, business.address, other)).governor];
    const first = await chat.say({ message: "Posts about my savings app, 20 MUSD in all" });
    const opened = await chat.say({ message: `Open it for ${business.address}`, token: first.token });
    const card = opened.cards.find((c) => c.type === "campaign") as unknown as { campaign: { governor: string } } | undefined;
    expect(card?.campaign.governor).to.be.a("string");
    expect(await factory.governorsOf(business.address)).to.deep.equal([...earlier, card!.campaign.governor]);
  });

  it("settles a transaction from the explorer when the RPC has no receipt", async () => {
    const noReceipt = { getTransactionReceipt: async () => null };
    let asked = 0;
    const explorer = async () => (++asked < 2 ? null : "ok" as const);
    expect(await settle(noReceipt, "0xabc", explorer, 5_000, 5)).to.equal("ok");
    expect(asked).to.equal(2); // asked every fifth poll, until it knew
    expect(await settle(noReceipt, "0xabc", async () => "failed" as const, 5_000, 5)).to.equal("failed");
    expect(await settle(noReceipt, "0xabc", undefined, 30, 5)).to.equal(null);
  });

  it("picks a nonce past a lagging RPC node, never gives two sends the same one, and retries a stale one once", async () => {
    let reads: number[] = [];
    const sent: number[] = [];
    let failNext = "";
    const provider = {
      getNetwork: async () => ({ chainId: 31611n }),
      getBlock: async () => ({ baseFeePerGas: 130n }),
      getFeeData: async () => ({ maxPriorityFeePerGas: 16n }),
      getTransactionCount: async () => (reads.length ? reads.shift()! : 4),
      getTransactionReceipt: async () => ({ status: 1 }),
    };
    const wallet = {
      address: "0xdD7d9fCD4cC600c9Dce907cd1B8c8728781E5145", provider,
      sendTransaction: async (tx: { nonce: number }) => {
        if (failNext) { const m = failNext; failNext = ""; throw new Error(m); }
        sent.push(tx.nonce);
        return { hash: `0x${String(tx.nonce).padStart(64, "0")}` };
      },
    };
    const sender = new KeySender(wallet as unknown as ConstructorParameters<typeof KeySender>[0]);
    const to = "0x0000000000000000000000000000000000000001";
    reads = [4, 0, 4]; // one node of three is behind
    await sender.send(to, "0x", 21_000n);
    // Two at once: the second waits for the first's broadcast and takes the next nonce, though the node still says 4.
    await Promise.all([sender.send(to, "0x", 21_000n), sender.send(to, "0x", 21_000n)]);
    expect(sent).to.deep.equal([4, 5, 6]);
    // A sequence error: read again without our own count, and try once more.
    failNext = "invalid sequence: account sequence mismatch, expected 9, got 7";
    reads = [7, 7, 7, 9, 9, 9];
    await sender.send(to, "0x", 21_000n);
    expect(sent.at(-1)).to.equal(9);
    // Anything else is not retried.
    failNext = "insufficient funds";
    let err = "";
    await sender.send(to, "0x", 21_000n).catch((e: Error) => { err = e.message; });
    expect(err).to.equal("insufficient funds");
  });

  it("answers in words on its last step, and never keeps a tool call nobody answered", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const sql = new PGlite() as unknown as Sql;
    await migrate(sql);
    const busy = () => ({ calls: [{ name: "campaign_status", args: {} }] });
    const model = new Script([
      ...Array.from({ length: 7 }, () => busy), () => ({ text: "Nothing is open yet; draft it first." }),
      // Next message: the model asks for a tool even on the last step, offered none.
      ...Array.from({ length: 8 }, () => busy),
      (msgs) => {
        // The unanswered call from the last step is not in the history: every tool call before here has its reply.
        const calls = msgs.flatMap((m) => ((m.tool_calls ?? []) as { id: string }[]).map((c) => c.id));
        const answered = new Set(msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
        expect(calls.every((id) => answered.has(id))).to.equal(true);
        return { text: "Here." };
      },
    ]);
    const chat = new OperatorChat({ sql, store: new Store(sql), book: new CreatorBook(sql), model, networks: [{ key: "mezo-testnet", name: "Mezo testnet", token: "MUSD" }], apply: async () => ({ error: "no" }) });
    const first = await chat.say({ message: "Status?" });
    expect(first.reply).to.equal("Nothing is open yet; draft it first.");
    expect(model.offered.slice(0, 8)).to.deep.equal([7, 7, 7, 7, 7, 7, 7, 0]);
    const second = await chat.say({ message: "And now?", token: first.token });
    expect(second.reply).to.equal("That is as far as I can take it in one go; tell me what to change.");
    expect((await chat.say({ message: "Go on", token: first.token })).reply).to.equal("Here.");
  });

  it("lets a creator see, answer and deliver on their own deal, and nobody else's", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const sql = new PGlite() as unknown as Sql;
    await migrate(sql);
    const store = new Store(sql);
    const book = new CreatorBook(sql);
    const made = await Promise.all(["Ada", "Bo"].map((name, i) => book.create({ name, wallet: `0x${String(i + 1).repeat(40)}`, networks: ["mezo-testnet"] })));
    const [ada, bo] = made.map((m) => { if ("error" in m) throw new Error(m.error); return m.creator; });
    await store.saveProject({ id: "savings-app", name: "Savings app", owner_address: "0x9999999999999999999999999999999999999999", network: "mezo-testnet", governor: null, brief: "A Bitcoin savings app.", links: [] });
    await store.saveTask({ id: "savings-app-a-post", project_id: "savings-app", kind: "x-post", title: "A post", done_when: "A post about the app", rate_min: 2_000_000n, rate_max: 5_000_000n, slots: 3, open: true });
    for (const c of [ada, bo]) {
      await store.addApplicant({ id: `app-${c.name}`, project_id: "savings-app", task_id: "savings-app-a-post", handle: c.name.toLowerCase(), wallet: c.wallet, email: null, pitch: "", samples: [], asked_rate: null, token: `secret-${c.name}` });
      await sql.query("update op_applicant set creator_id = $1, status = 'offered' where id = $2", [c.id, `app-${c.name}`]);
      await store.saveDeal({ id: ethers.id(`deal-${c.name}`), project_id: "savings-app", applicant_id: `app-${c.name}`, payee: c.wallet, amount: 4_000_000n, milestones: [{ title: "The post", amount: "4000000", criteria: "" }], terms: "", terms_hash: ethers.ZeroHash, deadline: new Date(Date.now() + 7 * 86_400_000), status: "offered", access_token: `deal-${c.name}`, chain_tx: null });
    }
    const asked: string[] = [];
    const chat = new OperatorChat({
      sql, store, book, networks: [{ key: "mezo-testnet", name: "Mezo testnet", token: "MUSD" }], apply: async () => ({ error: "not here" }),
      deals: {
        accept: async (t) => { asked.push(`accept ${t}`); return { kind: "deal_open", subject: t, detail: "$4 escrowed", tx: "0xabc" }; },
        decline: async (t) => { asked.push(`decline ${t}`); return { kind: "lapsed", subject: t, detail: "declined" }; },
        claim: async (t, m, u) => { asked.push(`claim ${t} ${m} ${u}`); return { id: "claim-1" }; },
      },
      model: new Script([
        () => ({ calls: [{ name: "my_status", args: {} }] }),
        (msgs) => {
          const apps = lastTool(msgs).applications;
          expect(apps).to.have.length(1); // Ada's, not Bo's
          expect(apps[0]).to.include({ task: "savings-app-a-post", status: "offered", pay_usd: 4, deal: "offered" });
          expect(apps[0]).to.not.have.property("claim_code"); // a code only once the deal is open
          return { calls: [{ name: "submit_delivery", args: { task_id: "savings-app-a-post", url: "https://x.com/ada/status/1" } }] };
        },
        (msgs) => {
          expect(lastTool(msgs).error).to.contain("no accepted deal"); // nothing to deliver on before accepting
          return { calls: [{ name: "answer_offer", args: { task_id: "savings-app-a-post", accept: true } }] };
        },
        () => ({ text: "Accepted." }),
        () => ({ calls: [{ name: "submit_delivery", args: { task_id: "savings-app-a-post", url: "https://x.com/ada/status/2" } }] }),
        (msgs) => {
          expect(lastTool(msgs)).to.include({ submitted: true });
          return { calls: [{ name: "my_status", args: {} }] };
        },
        (msgs) => {
          expect(lastTool(msgs).applications[0]).to.include({ deal: "open", claim_code: `qop-${ethers.id("deal-Ada").slice(2, 8)}` });
          return { text: "Sent." };
        },
      ]),
    });
    const first = await chat.say({ message: "Where are my applications? Accept the offer.", role: "creator", creatorToken: ada.token });
    expect(first.cards.find((c) => c.type === "deal")).to.include({ status: "deal_open", tx: "0xabc" });
    expect(asked).to.deep.equal(["accept secret-Ada"]);
    // The hub's accept moves the deal on; then the delivery goes against Ada's own application.
    await sql.query("update op_applicant set status = 'accepted' where id = 'app-Ada'");
    await store.setDeal(ethers.id("deal-Ada"), "open");
    await chat.say({ message: "Here is my post: https://x.com/ada/status/2", token: first.token });
    expect(asked).to.deep.equal(["accept secret-Ada", "claim secret-Ada 0 https://x.com/ada/status/2"]);
  });
});
