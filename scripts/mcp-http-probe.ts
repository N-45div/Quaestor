/**
 * Reach the hub's HTTP MCP endpoint the way a hosted agent would, and check
 * the things that matter before handing the URL to one:
 *
 *   1. without the agent key it is refused — before any tool is listed
 *   2. with the key as a Bearer token the tools are listed
 *   3. the same key as X-API-Key works too (hosts differ on which they send)
 *   4. a real tool call returns live market evidence
 *
 *   5. with --trade: a 1 USDC trade, quote -> preview -> execute, and the same
 *      intent again to show a retry returns the same order instead of a second
 *
 *   STOCKS_MCP_API_KEY=... npm run mcp:probe -- https://host/mcp [instrumentMint] [--trade] [--venue id]
 */
import * as dotenv from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

dotenv.config();

const url = new URL(process.argv[2] ?? "http://127.0.0.1:8402/mcp");
const mint = process.argv[3]?.startsWith("--") ? undefined : process.argv[3];
const trade = process.argv.includes("--trade");
const venueFlag = process.argv.indexOf("--venue");
const venue = venueFlag > 0 ? process.argv[venueFlag + 1] : undefined;
const key = process.env.STOCKS_MCP_API_KEY ?? "";

async function connect(headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "quaestor-mcp-probe", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

async function main(): Promise<void> {
  if (!key) throw new Error("STOCKS_MCP_API_KEY is not set");
  let failed = false;
  const check = (label: string, ok: boolean, detail: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${label} — ${detail}`);
    if (!ok) failed = true;
  };

  let open = false;
  try {
    await (await connect({})).close();
    open = true;
  } catch { /* refused, as it should be */ }
  check("no key is refused", !open, open ? "the endpoint answered without a key" : "401 before any tool was listed");

  let wrong = false;
  try {
    await (await connect({ Authorization: "Bearer not-the-key-but-the-same-length-ish" })).close();
    wrong = true;
  } catch { /* refused */ }
  check("a wrong key is refused", !wrong, wrong ? "a wrong key was accepted" : "401");

  const bearer = await connect({ Authorization: `Bearer ${key}` });
  const tools = (await bearer.listTools()).tools.map((tool) => tool.name);
  check("Bearer key lists the tools", tools.includes("quaestor_stock_execute"), `${tools.length} tools: ${tools.join(", ")}`);

  const apiKey = await connect({ "X-API-Key": key });
  check("X-API-Key works too", (await apiKey.listTools()).tools.length === tools.length, "same tools");
  await apiKey.close();

  if (mint) {
    const result = await bearer.callTool({ name: "quaestor_stock_market", arguments: { instrument_mint: mint } });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
    const market = JSON.parse(text) as {
      allowed?: boolean;
      session?: string;
      refusal?: { code: string };
      consensus?: { reference?: { price: number; sources: string[]; spread_bps: number } };
    };
    const reference = market.consensus?.reference;
    check(
      "a tool call returns live evidence",
      market.allowed !== undefined,
      reference
        ? `allowed=${market.allowed} session=${market.session} reference $${reference.price} from ${reference.sources.join(" + ")} (spread ${reference.spread_bps}bps)`
        : `allowed=${market.allowed} refusal=${market.refusal?.code ?? "none"}`,
    );
  }
  if (mint && trade) {
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await bearer.callTool({ name, arguments: args });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
      // A tool that failed answers in prose, not JSON; report it, don't choke on it.
      try { return JSON.parse(text); } catch { return { tool_error: text }; }
    };
    const quote = await call("quaestor_stock_quote", { instrument_mint: mint, amount_in_usdc: "1000000", ...(venue ? { venue } : {}) });
    if (quote.tool_error) check("quote", false, quote.tool_error);
    check("quote carries the gate's verdict", quote.market?.quote !== undefined,
      `${quote.route}; floor implies $${quote.market?.quote?.floor_price_usd} vs $${quote.market?.quote?.benchmark_price_usd} (${quote.market?.quote?.deviation_bps}bps), allowed=${quote.market?.allowed}`);
    const order = { quote_id: quote.quote_id, strategy: "probe", rationale: "Smoke test of the hosted endpoint: one 1 USDC trade inside the owner's caps." };
    const previewed = await call("quaestor_stock_policy_preview", order);
    check("preview allows it", previewed.preview?.allowed === true, `allowed=${previewed.preview?.allowed} ${previewed.preview?.refusal?.code ?? ""}`);
    const intent = { ...order, intent_id: previewed.request.intent_id, intent_expires_at: previewed.request.intent_expires_at };
    const executed = await call("quaestor_stock_execute", intent);
    check("execute settles on chain", executed.status === "settled",
      `status=${executed.status} ${executed.refusal?.code ?? ""} tx=${executed.receipt?.transaction_signature ?? "-"}`);
    const again = await call("quaestor_stock_execute", intent);
    check("a retry returns the same order", again.order_id === executed.order_id
      && again.receipt?.transaction_signature === executed.receipt?.transaction_signature, `order ${again.order_id}`);
  }
  await bearer.close();
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
