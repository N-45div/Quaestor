import { expect } from "chai";
import express from "express";
import type { AddressInfo } from "node:net";
import { kimi, mountMonadAgent, runAgent, SYSTEM, TOOLS, type AgentTools, type ChatMessage, type ChatModel, type MonadAgentConfig } from "../services/monad-agent";

/**
 * The house agent's loop with the model and the chain stood in: the model's tool calls reach the
 * tools and their results come back as data, a run buys at most once (a second buy is refused
 * without reaching the chain), a failing tool is an answer, not a crash, and the request to Kimi
 * has the shape Moonshot's OpenAI-compatible API takes.
 */
describe("monad house agent", () => {
  const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

  function scripted(replies: ChatMessage[]): { model: ChatModel; seen: ChatMessage[][] } {
    const seen: ChatMessage[][] = [];
    return { seen, model: async (messages) => { seen.push(messages.map((m) => ({ ...m }))); return replies.shift() ?? { role: "assistant", content: "done" }; } };
  }

  function tools(buys: { stock: string; amount: number; reason: string }[] = [], fail = false): AgentTools {
    return {
      portfolio: async () => ({ ok: true, canSpendNow: "18 tUSDC", stocks: [{ stock: "tNVDA", held: "0" }, { stock: "tTSLA", held: "0.01" }] }),
      quotes: async (amount) => {
        if (fail) throw new Error("rpc down");
        return [{ stock: "tNVDA", spend: `${amount} tUSDC`, chainlinkPremiumBps: 12 }, { stock: "tTSLA", spend: `${amount} tUSDC`, chainlinkPremiumBps: 90 }];
      },
      buy: async (stock, amount, reason) => { buys.push({ stock, amount, reason }); return { ok: true, bought: true, tx: "https://testnet.monadscan.com/tx/0xabc" }; },
    };
  }

  it("reads, quotes and buys once, with the model's reason, and hands results back as data", async () => {
    const buys: { stock: string; amount: number; reason: string }[] = [];
    const { model, seen } = scripted([
      { role: "assistant", content: null, tool_calls: [call("1", "get_portfolio", {}), call("2", "get_quotes", { amount_usd: 2 })], reasoning_content: "think" },
      { role: "assistant", content: null, tool_calls: [call("3", "buy", { stock: "tNVDA", amount_usd: 2, reason: "Held least and within 12 bps of Chainlink." })] },
      { role: "assistant", content: "Bought 2 tUSDC of tNVDA: held least, 12 bps over Chainlink." },
    ]);
    const run = await runAgent(model, tools(buys), "mandate text", "cre");
    expect(buys).to.deep.equal([{ stock: "tNVDA", amount: 2, reason: "Held least and within 12 bps of Chainlink." }]);
    expect(run.tx).to.equal("https://testnet.monadscan.com/tx/0xabc");
    expect(run.summary).to.contain("Bought 2 tUSDC of tNVDA");
    expect(run.steps.map((s) => s.tool)).to.deep.equal(["get_portfolio", "get_quotes", "buy"]);
    // The model's own message (with Kimi's reasoning) goes back unchanged; tool results are tool messages.
    expect(seen[1][2]).to.include({ reasoning_content: "think" });
    expect(seen[1].filter((m) => m.role === "tool").map((m) => m.tool_call_id)).to.deep.equal(["1", "2"]);
    expect(seen[0][0].content).to.equal(SYSTEM);
    expect(seen[0][1].content).to.contain("mandate text").and.contain("started by: cre");
  });

  it("refuses a second buy in one run without reaching the chain, and survives a failing tool", async () => {
    const buys: { stock: string; amount: number; reason: string }[] = [];
    const { model } = scripted([
      { role: "assistant", content: null, tool_calls: [call("1", "buy", { stock: "tNVDA", amount_usd: 1, reason: "a" }), call("2", "buy", { stock: "tTSLA", amount_usd: 1, reason: "b" })] },
      { role: "assistant", content: null, tool_calls: [call("3", "get_quotes", { amount_usd: 1 })] },
      { role: "assistant", content: "Stopped." },
    ]);
    const run = await runAgent(model, tools(buys, true), "m", "manual");
    expect(buys).to.have.length(1);
    expect(run.steps[1].result).to.include({ refused: "OneBuyPerRun" });
    expect(run.steps[2].result).to.include({ ok: false, error: "rpc down" });
  });

  it("asks Kimi with Moonshot's OpenAI-compatible request, tools and all", async () => {
    let sent: { url: string; body: Record<string, unknown>; auth: string } | null = null;
    const fetchFn = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      sent = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }) };
    }) as unknown as typeof fetch;
    const reply = await kimi("sk-test", "kimi-k2.6", undefined, fetchFn)([{ role: "user", content: "hi" }], TOOLS);
    expect(reply.content).to.equal("ok");
    expect(sent!.url).to.equal("https://api.moonshot.ai/v1/chat/completions");
    expect(sent!.auth).to.equal("Bearer sk-test");
    expect(sent!.body).to.include({ model: "kimi-k2.6", tool_choice: "auto" });
    expect((sent!.body.tools as { function: { name: string } }[]).map((t) => t.function.name)).to.deep.equal(["get_portfolio", "get_quotes", "buy"]);
  });

  it("starts a run only with the agent's secret, answers Chainlink CRE at once, and never runs twice at the same time", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const model: ChatModel = async () => { calls += 1; await gate; return { role: "assistant", content: "Not trading." }; };
    const cfg = { signer: { address: "0xc813451F9Fe540B754AbE526bAc4EE19E4043fF8", warm: async () => undefined }, model, modelName: "kimi-k2.6", mandate: "m", secret: "s3cret", tools: tools() } as unknown as MonadAgentConfig;
    const app = express();
    mountMonadAgent(app, cfg);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/evm/monad-testnet/agent`;
    const post = (secret: string, body: object) => fetch(`${url}/run`, { method: "POST", headers: { "content-type": "application/json", "x-agent-secret": secret }, body: JSON.stringify(body) });
    try {
      expect((await post("wrong", {})).status).to.equal(401);
      const first = await post("s3cret", { trigger: "chainlink-cre", wait: false, note: "fresh NVDA" });
      expect(first.status).to.equal(202);
      expect(await first.json()).to.deep.equal({ started: true, running: true });
      expect(await (await post("s3cret", { trigger: "chainlink-cre", wait: false })).json()).to.deep.equal({ started: false, running: true });
      release();
      await new Promise((r) => setTimeout(r, 50));
      const view = (await (await fetch(url)).json()) as { runs: { trigger: string; summary: string }[]; running: boolean };
      expect(calls).to.equal(1);
      expect(view.running).to.equal(false);
      expect(view.runs[0]).to.include({ trigger: "chainlink-cre", summary: "Not trading." });
    } finally {
      server.close();
    }
  });
});
