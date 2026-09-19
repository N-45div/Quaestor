/**
 * The stock tools over HTTP, for agents that live somewhere else.
 *
 * `mcp/stocks-server.ts` speaks MCP over stdio, which suits an agent running
 * on the same machine. Hosted agents — Bankr's, Grok Bot's — run on their own
 * cloud computers and can only reach a URL. This mounts the same tools on the
 * hub itself as a Streamable HTTP endpoint, so such an agent is one "add an
 * MCP server at …" away from trading through the governor.
 *
 * Two credentials, deliberately kept apart:
 *
 *   the agent key       what a remote agent presents to reach this endpoint.
 *                       It authorises *talking to the tools*, nothing more.
 *   the operator token  what the tools present to the hub to execute. It
 *                       stays in this process; no remote agent ever holds it.
 *
 * So a leaked agent key lets someone quote and trade inside the owner's caps —
 * bounded by the program — and never lets them become the operator elsewhere.
 *
 * Stateless: each request gets a fresh server and transport, and the tools
 * themselves hold no session state, so there is nothing to lose between calls
 * and nothing for a stale session id to reach.
 */
import express, { type Express, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { QuaestorStocksClient } from "../sdk";
import { registerStockTools } from "../mcp/stocks";

export interface StocksMcpConfig {
  /** Where the tools reach the hub — this same process, normally. */
  platformBaseUrl: string;
  agentId: string;
  /** Lets the execute tool trade. Absent, the endpoint quotes and previews only. */
  operatorToken?: string;
  /** What a remote agent must present. Long enough that guessing is not a plan. */
  apiKey: string;
  path?: string;
}

const MIN_KEY_LENGTH = 24;

export function mountStocksMcp(app: Express, cfg: StocksMcpConfig): void {
  if (cfg.apiKey.length < MIN_KEY_LENGTH) {
    throw new Error(`STOCKS_MCP_API_KEY must be at least ${MIN_KEY_LENGTH} characters`);
  }
  const path = cfg.path ?? "/mcp";
  const client = new QuaestorStocksClient({ baseUrl: cfg.platformBaseUrl, operatorToken: cfg.operatorToken });

  const handle = async (req: Request, res: Response): Promise<void> => {
    if (!authorised(req, cfg.apiKey)) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: present the agent key as Authorization: Bearer <key> or X-API-Key" },
        id: null,
      });
      return;
    }
    const server = new McpServer({ name: "quaestor-stocks", version: "0.1.0" });
    registerStockTools(server, client, cfg.agentId);
    // No session id: a remote agent may be load-balanced or restarted between
    // calls, and there is no state here worth making it resume.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: (error as Error).message ?? "internal error" },
          id: null,
        });
      }
    }
  };

  // A tool result is a JSON document, not a stream of files: 256kb is generous.
  app.all(path, express.json({ limit: "256kb" }), (req, res) => void handle(req, res));

  console.log(
    `[stocks-mcp] mounted at ${path} — agent ${cfg.agentId}, `
    + (cfg.operatorToken ? "execute enabled" : "quote and preview only (no operator token)"),
  );
}

/** Either header, compared in constant time. */
function authorised(req: Request, apiKey: string): boolean {
  const presented = bearer(req) ?? header(req, "x-api-key");
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(apiKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req: Request): string | undefined {
  const value = header(req, "authorization");
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : undefined;
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function stocksMcpFromEnv(port: number): StocksMcpConfig | null {
  if (process.env.STOCKS_MCP_ENABLED !== "1") return null;
  const apiKey = process.env.STOCKS_MCP_API_KEY;
  if (!apiKey || apiKey.length < MIN_KEY_LENGTH) {
    console.error(`[stocks-mcp] not mounted — STOCKS_MCP_API_KEY (${MIN_KEY_LENGTH}+ chars) is required`);
    return null;
  }
  return {
    platformBaseUrl: process.env.STOCKS_MCP_PLATFORM_URL ?? `http://127.0.0.1:${port}`,
    agentId: process.env.SOLANA_STOCK_AGENT_ID ?? "solana-agent-1",
    operatorToken: process.env.SOLANA_STOCK_OPERATOR_TOKEN,
    apiKey,
    path: process.env.STOCKS_MCP_PATH ?? "/mcp",
  };
}
