import { expect } from "chai";
import { ethers } from "hardhat";
import { Store, migrate, type Sql } from "../operator/db";
import { CreatorBook } from "../operator/creators";
import { KeySender } from "../operator/chain";
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
  constructor(private readonly steps: Step[]) {}
  async turn(messages: ChatMessage[]): Promise<ModelTurn> {
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
    const factory = await (await ethers.getContractFactory("QuaestorPayouts")).deploy();
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
    return { chat, store, token, operatorKey, business, funder };
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
});
