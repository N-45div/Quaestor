/**
 * MCP server for the Solana stocks lane on its own.
 *
 * `mcp/server.ts` is built around the EVM governor and will not start without an
 * EVM agent id and an EVM operator private key. An agent that only trades
 * tokenized stocks on Solana has neither, and should not be asked for a private
 * key it will never use. This entry point registers the stock tools and nothing
 * else, so the only credential it can hold is the scoped operator token.
 *
 *   STOCKS_API_URL=http://127.0.0.1:8402 \
 *   SOLANA_STOCK_AGENT_ID=solana-agent-1 \
 *   SOLANA_STOCK_OPERATOR_TOKEN=... \
 *   npm run mcp:stocks
 *
 * Without the operator token the agent can still discover, quote and preview;
 * only execution needs it.
 */
import * as dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QuaestorStocksClient } from "../sdk";
import { registerStockTools } from "./stocks";

dotenv.config();

// stdout carries the MCP protocol, so anything human-readable goes to stderr.
const log = (message: string) => console.error(`[quaestor-mcp-stocks] ${message}`);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    log(`missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const baseUrl = required("STOCKS_API_URL");
  const agentId = required("SOLANA_STOCK_AGENT_ID");
  const operatorToken = process.env.SOLANA_STOCK_OPERATOR_TOKEN;

  const server = new McpServer({ name: "quaestor-stocks", version: "0.1.0" });
  registerStockTools(server, new QuaestorStocksClient({ baseUrl, operatorToken }), agentId);

  log(`agent ${agentId} → ${baseUrl}`);
  log(operatorToken
    ? "operator token present: discover, quote, preview and execute"
    : "no operator token: discover, quote and preview only — execution will be refused");

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
