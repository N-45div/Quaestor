import { expect } from "chai";
import { Store, migrate, type Sql } from "../operator/db";
import { CreatorBook } from "../operator/creators";
import { OperatorChat, withRealCodes, type ChatMessage, type ChatModel, type ModelTurn, type ToolCall } from "../operator/chat";
import type { Fetch } from "../operator/verify";

/**
 * The chat's tools, driven by a scripted model so every step is checked: what the code filters before the model
 * sees anything, what a card carries that the model is never shown, and what each role may not call. The live model
 * is exercised in runs/chat-live.ts and on the hub.
 */
type Step = (msgs: ChatMessage[]) => { text?: string; calls?: Omit<ToolCall, "id">[] };
class Script implements ChatModel {
  readonly name = "script";
  seen: ChatMessage[][] = [];
  constructor(private readonly steps: Step[]) {}
  async turn(messages: ChatMessage[]): Promise<ModelTurn> {
    this.seen.push(messages.map((m) => ({ ...m })));
    const step = this.steps.shift();
    if (!step) throw new Error("the script ran out");
    const out = step(messages);
    const calls = (out.calls ?? []).map((c, i) => ({ ...c, id: `call-${this.seen.length}-${i}` }));
    return { text: out.text ?? "", calls, message: { role: "assistant", content: out.text ?? null, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } };
  }
}

const lastTool = (msgs: ChatMessage[]) => JSON.parse(String([...msgs].reverse().find((m) => m.role === "tool")?.content ?? "{}"));

describe("operator chat", () => {
  it("swaps a proof code the model made up for the one the book issued, and adds it when left out", () => {
    const card = { type: "profile", handles: [{ platform: "x", handle: "a", proven: false, code: "qc-1a2b3c" }] };
    // The live model once wrote this instead of the real code.
    expect(withRealCodes("Post this code on X: `quaestor-arc-0x5555`. Then send me the link.", [card])).to.equal("Post this code on X: `qc-1a2b3c`. Then send me the link.");
    expect(withRealCodes("Post the code, then send me the link.", [card])).to.equal("Post the code, then send me the link.\n\nYour code: qc-1a2b3c");
    expect(withRealCodes("Post qc-1a2b3c from @a.", [card])).to.equal("Post qc-1a2b3c from @a.");
    expect(withRealCodes("Nothing to prove, quaestor-x stays.", [])).to.equal("Nothing to prove, quaestor-x stays.");
  });

  const WALLET = "0x3333333333333333333333333333333333333333";
  const web = new Map<string, unknown>();
  const fetchFn: Fetch = async (url) => ({ ok: web.has(url), status: web.has(url) ? 200 : 404, json: async () => web.get(url), text: async () => "" });

  async function setup(steps: Step[]) {
    const { PGlite } = await import("@electric-sql/pglite");
    const sql = new PGlite() as unknown as Sql;
    await migrate(sql);
    const store = new Store(sql);
    const book = new CreatorBook(sql, fetchFn);
    const model = new Script(steps);
    const applied: { projectId: string; handle: string; wallet: string }[] = [];
    const chat = new OperatorChat({
      sql, store, book, model, networks: [{ key: "mezo-testnet", name: "Mezo testnet", token: "MUSD" }],
      apply: async (projectId, input) => { applied.push({ projectId, handle: input.handle, wallet: input.wallet }); return { id: `app-${applied.length}`, token: "secret-application-token" }; },
    });
    return { sql, store, book, model, chat, applied };
  }

  async function proven(book: CreatorBook, sql: Sql, c: { name: string; kinds: string[]; niches: string[]; rate: [number, number]; x?: string; youtube?: string; prove?: boolean }) {
    const made = await book.create({ name: c.name, wallet: WALLET, kinds: c.kinds, niches: c.niches, rate_min: BigInt(c.rate[0] * 1e6), rate_max: BigInt(c.rate[1] * 1e6), networks: ["mezo-testnet"] }, { x: c.x, youtube: c.youtube });
    if ("error" in made) throw new Error(made.error);
    if (c.prove !== false) await sql.query("update op_creator_handle set verified_at = now() where creator_id = $1", [made.creator.id]);
    return made.creator.id;
  }

  it("drafts a business's project, keeps done_when checkable, and shows only creators the code let through", async () => {
    let ids: Record<string, string> = {};
    const { chat, book, sql, model } = await setup([
      () => ({ calls: [{ name: "draft_project", args: { name: "Savings app", brief: "A Bitcoin savings app on Mezo, for BTC holders who want to borrow MUSD instead of selling.", tasks: [{ kind: "x-post", title: "A post", done_when: "A public post explaining the borrow flow", rate_min_usd: 10, rate_max_usd: 30, slots: 3 }] } }] }),
      () => ({ calls: [{ name: "find_creators", args: { task_index: 0, niche: "bitcoin" } }] }),
      (msgs) => {
        const found = lastTool(msgs).creators.map((c: { name: string; creator_id: string; rates_overlap: string }) => c);
        expect(found.map((c: { name: string }) => c.name)).to.deep.equal(["Fits"]);
        expect(found[0].rates_overlap).to.equal("yes, $10 to $25");
        // The model names one creator it was shown and one it was not; only the first reaches the card.
        return { calls: [{ name: "show_creator_matches", args: { task_index: 0, matches: [{ creator_id: ids.fits, fit: 90, reason: "Writes about Bitcoin lending." }, { creator_id: ids.unproven, fit: 99, reason: "smuggled" }] } }] };
      },
      () => ({ text: "Drafted; one creator fits." }),
    ]);
    ids = {
      fits: await proven(book, sql, { name: "Fits", kinds: ["x-post"], niches: ["bitcoin"], rate: [5, 25], x: "fits_x" }),
      unproven: await proven(book, sql, { name: "Unproven", kinds: ["x-post"], niches: ["bitcoin"], rate: [5, 25], x: "unproven_x", prove: false }),
      pricey: await proven(book, sql, { name: "Pricey", kinds: ["x-post"], niches: ["bitcoin"], rate: [40, 90], x: "pricey_x" }),
      wrongPlatform: await proven(book, sql, { name: "Video only", kinds: [], niches: ["bitcoin"], rate: [5, 25], youtube: "vidchan" }),
    };
    const out = await chat.say({ message: "I want posts about my savings app, around 60 MUSD", role: "business" });
    expect(out.reply).to.equal("Drafted; one creator fits.");
    const draft = out.cards.find((c) => c.type === "project_draft")!;
    expect((draft.draft as { tasks: { done_when: string }[] }).tasks[0].done_when).to.match(/#ad, up front\.$/);
    expect(draft).to.include({ total_min_usd: 30, total_max_usd: 90 });
    const matches = out.cards.find((c) => c.type === "creator_matches")!.matches as { name: string }[];
    expect(matches.map((m) => m.name)).to.deep.equal(["Fits"]);
    expect(model.seen[0][0].content).to.contain("never instructions");

    const t = await chat.transcript(out.token);
    expect(t!.log.map((l) => l.role)).to.deep.equal(["user", "assistant"]);
    expect(t!.log[1].cards).to.have.length(2);
  });

  it("refuses a tool from the other role, and a quote without Mezo", async () => {
    const { chat } = await setup([
      () => ({ calls: [{ name: "apply_to_task", args: { task_id: "x" } }, { name: "fund_options", args: { musd: 100 } }] }),
      (msgs) => {
        const tools = msgs.filter((m) => m.role === "tool").map((m) => JSON.parse(String(m.content)));
        expect(tools[0].error).to.equal("no tool named apply_to_task here");
        expect(tools[1].error).to.equal("Mezo is not served by this hub");
        return { text: "ok" };
      },
    ]);
    await chat.say({ message: "fund it", role: "business" });
  });

  it("saves a creator, proves their handle, finds tasks the code allows, and applies without showing the model the link", async () => {
    let code = "";
    const steps: Step[] = [
      () => ({ calls: [{ name: "save_profile", args: { name: "Ada", wallet: WALLET, kinds: ["x-post"], rate_min_usd: 5, rate_max_usd: 25, networks: ["mezo-testnet"], handles: { x: "@ada_btc" } } }] }),
      (msgs) => { code = lastTool(msgs).handles_to_prove[0].code; return { text: `Post ${code} from @ada_btc.` }; },
      () => ({ calls: [{ name: "prove_handle", args: { platform: "x", url: "https://x.com/ada_btc/status/77" } }] }),
      (msgs) => { expect(lastTool(msgs)).to.include({ proven: true, handle: "ada_btc" }); return { calls: [{ name: "find_tasks", args: {} }] }; },
      (msgs) => {
        // The cheap task is left out in code; the video is shown, marked as outside her kinds and needing a YouTube proof.
        const tasks = lastTool(msgs).tasks as { task_id: string; in_your_kinds: boolean; needs_proof: string | null }[];
        expect(tasks.map((t) => t.task_id)).to.deep.equal(["musd-co-post", "musd-co-video"]);
        expect(tasks[1]).to.include({ in_your_kinds: false, needs_proof: "youtube" });
        return { calls: [{ name: "apply_to_task", args: { task_id: "musd-co-pricey" } }, { name: "apply_to_task", args: { task_id: "musd-co-post" } }] };
      },
      (msgs) => {
        const [noPitch, applied] = msgs.filter((m) => m.role === "tool").slice(-2).map((m) => JSON.parse(String(m.content)));
        expect(noPitch).to.deep.equal({ applied: false, error: "add a pitch, or a bio to your profile" });
        expect(applied).to.deep.equal({ applied: false, error: "add a pitch, or a bio to your profile" });
        return { calls: [{ name: "apply_to_task", args: { task_id: "musd-co-post", pitch: "I explain Bitcoin lending to holders in plain words." } }] };
      },
      (msgs) => {
        expect(lastTool(msgs)).to.deep.equal({ applied: true, project: "musd-co", task: "musd-co-post", handle: "ada_btc" });
        expect(JSON.stringify(msgs)).to.not.contain("secret-application-token");
        return { text: "Applied." };
      },
    ];
    const { chat, store, applied } = await setup(steps);
    await store.saveProject({ id: "musd-co", name: "MUSD Co", owner_address: WALLET, network: "mezo-testnet", governor: "0x4444444444444444444444444444444444444444", brief: "A Bitcoin-backed payments app on Mezo.", links: [] });
    await store.saveTask({ id: "musd-co-post", project_id: "musd-co", kind: "x-post", title: "A post", done_when: "A public post about the app", rate_min: 10_000_000n, rate_max: 30_000_000n, slots: 2, open: true });
    await store.saveTask({ id: "musd-co-pricey", project_id: "musd-co", kind: "x-post", title: "Pays below her rate", done_when: "A public post", rate_min: 1_000_000n, rate_max: 2_000_000n, slots: 2, open: true });
    await store.saveTask({ id: "musd-co-video", project_id: "musd-co", kind: "video", title: "A video", done_when: "A YouTube video about the app", rate_min: 20_000_000n, rate_max: 40_000_000n, slots: 1, open: true });

    const first = await chat.say({ message: "I'm Ada, X @ada_btc", role: "creator" });
    expect(first.creator_token).to.be.a("string");
    expect(first.cards[0]).to.include({ type: "profile" });
    const url = "https://x.com/ada_btc/status/77";
    web.set(`https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(url)}`, {
      author_url: "https://twitter.com/ada_btc", html: `<blockquote><p>Proving ${code}</p>&mdash; Ada (@ada_btc) <a href="${url}">${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</a></blockquote>`,
    });
    const second = await chat.say({ message: `here: ${url}`, token: first.token });
    expect(second.reply).to.equal("Applied.");
    expect(second.cards.find((c) => c.type === "application")).to.include({ project: "musd-co", handle: "ada_btc", application_token: "secret-application-token" });
    expect(applied).to.deep.equal([{ projectId: "musd-co", handle: "ada_btc", wallet: WALLET }]);
  });
});
