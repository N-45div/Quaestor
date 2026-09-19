/**
 * Reach the hub's HTTP MCP endpoint the way a hosted agent would, and check
 * the things that matter before handing the URL to one:
 *
 *   1. without a key: either refused, or — where public reads are on — served
 *      the read-only tools with the execute tool ABSENT
 *   2. a key that is presented and wrong is refused, never quietly downgraded
 *   3. with the key the tools are listed, execute included, under either header
 *   4. a real tool call returns live market evidence, framed as data
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
  const client = new Client({ name: "quaestor-mcp-probe", version: "0.2.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

/** A tool's answer: its `data` on success, `tool_error` when the tool said no. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
  let parsed: { notice?: string; data?: unknown; error?: { code: string; message: string } };
  try {
    parsed = JSON.parse(text);
  } catch {
    return { tool_error: { code: "NOT_JSON", message: text.slice(0, 200) } };
  }
  if (result.isError || parsed.error) {
    return { tool_error: parsed.error ?? { code: "TOOL_ERROR", message: text.slice(0, 200) } };
  }
  return { framed: typeof parsed.notice === "string", ...(parsed.data as Record<string, unknown>) };
}

async function main(): Promise<void> {
  if (!key) throw new Error("STOCKS_MCP_API_KEY is not set");
  let failed = false;
  const check = (label: string, ok: boolean, detail: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${label} — ${detail}`);
    if (!ok) failed = true;
  };

  try {
    const anonymous = await connect({});
    const tools = (await anonymous.listTools()).tools.map((tool) => tool.name);
    await anonymous.close();
    check(
      "no key gets the read-only tools and nothing that trades",
      !tools.includes("quaestor_stock_execute") && tools.includes("quaestor_stock_quote"),
      `${tools.length} tools, execute ${tools.includes("quaestor_stock_execute") ? "PRESENT" : "absent"}`,
    );
  } catch {
    check("no key is refused", true, "401 before any tool was listed (public reads are off)");
  }

  let wrong = false;
  try {
    await (await connect({ Authorization: "Bearer not-the-key-but-the-same-length-ish" })).close();
    wrong = true;
  } catch { /* refused */ }
  check("a wrong key is refused, not downgraded", !wrong, wrong ? "a wrong key was accepted" : "401");

  const bearer = await connect({ Authorization: `Bearer ${key}` });
  const tools = (await bearer.listTools()).tools.map((tool) => tool.name);
  check("the key lists the tools, execute included", tools.includes("quaestor_stock_execute"), `${tools.length} tools`);

  const apiKey = await connect({ "X-API-Key": key });
  check("X-API-Key works too", (await apiKey.listTools()).tools.length === tools.length, "same tools");
  await apiKey.close();

  if (mint) {
    const market = await call(bearer, "quaestor_stock_market", { instrument_mint: mint });
    const reference = market.consensus?.reference;
    check(
      "a tool call returns live evidence, framed as data",
      market.allowed !== undefined && market.framed === true,
      reference
        ? `allowed=${market.allowed} session=${market.session} reference $${reference.price} from ${reference.sources.join(" + ")} (spread ${reference.spread_bps}bps)`
        : `allowed=${market.allowed} refusal=${market.refusal?.code ?? market.tool_error?.code ?? "none"}`,
    );
  }

  if (mint && trade) {
    const dust = await call(bearer, "quaestor_stock_quote", { instrument_mint: mint, amount_in_usdc: "1" });
    check("a dust trade is refused before it can cost the fee payer anything",
      dust.tool_error?.code === "AMOUNT_TOO_SMALL", dust.tool_error?.code ?? "it was quoted");

    const quote = await call(bearer, "quaestor_stock_quote", { instrument_mint: mint, amount_in_usdc: "1000000", ...(venue ? { venue } : {}) });
    check("quote carries the gate's verdict", quote.market?.quote !== undefined,
      quote.tool_error
        ? `${quote.tool_error.code}: ${quote.tool_error.message}`
        : `${quote.route}; floor implies $${quote.market?.quote?.floor_price_usd} vs $${quote.market?.quote?.benchmark_price_usd} (${quote.market?.quote?.deviation_bps}bps), allowed=${quote.market?.allowed}`);
    const order = { quote_id: quote.quote_id, strategy: "probe", rationale: "Smoke test of the hosted endpoint: one 1 USDC trade inside the owner's caps." };
    const previewed = await call(bearer, "quaestor_stock_policy_preview", order);
    check("preview allows it and mints the intent",
      previewed.preview?.allowed === true && typeof previewed.request?.intent_id === "string",
      `allowed=${previewed.preview?.allowed} ${previewed.preview?.refusal?.code ?? previewed.tool_error?.code ?? ""}`);
    const intent = { ...order, intent_id: previewed.request?.intent_id, intent_expires_at: previewed.request?.intent_expires_at };
    const executed = await call(bearer, "quaestor_stock_execute", intent);
    check("execute settles on chain", executed.status === "settled",
      `status=${executed.status ?? executed.tool_error?.code} ${executed.refusal?.code ?? ""} tx=${executed.receipt?.transaction_signature ?? "-"}`);
    const again = await call(bearer, "quaestor_stock_execute", intent);
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
