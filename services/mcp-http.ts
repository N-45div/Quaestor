/**
 * The stock tools over HTTP, for agents that live somewhere else.
 *
 * `mcp/stocks-server.ts` speaks MCP over stdio, which suits an agent running
 * on the same machine. Hosted agents — Bankr's, Grok Bot's — run on their own
 * cloud computers and can only reach a URL. This mounts the same tools on the
 * hub itself as a Streamable HTTP endpoint, so such an agent is one "add an
 * MCP server at …" away from trading through the governor.
 *
 * Two tiers, and two credentials kept apart:
 *
 *   no key              every tool that reads — discover, venues, evidence,
 *                       prices, quote, preview — and none that trades. The
 *                       execute tool is absent, not present-and-refusing.
 *   an agent key        the same, plus execute. It authorises talking to the
 *                       tools and nothing else. Keys are named, so one can be
 *                       revoked without disturbing the others.
 *   the operator token  what the tools present to the hub to execute. It
 *                       stays in this process; no remote agent ever holds it.
 *
 * So a leaked agent key lets someone trade inside the owner's caps — bounded by
 * the program, by a minimum size and by a daily count — and never lets them
 * become the operator anywhere else.
 *
 * Stateless: each request gets a fresh server and transport, and the tools
 * hold no session state, so there is nothing to lose between calls and nothing
 * for a stale session id to reach.
 */
import express, { type Express, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { QuaestorStocksClient } from "../sdk";
import { registerStockTools, STOCK_SERVER_INSTRUCTIONS } from "../mcp/stocks";
import { safeMessage } from "../stocks/redact";
import { concurrencyLimit, rateLimit } from "./hardening";

export interface StocksMcpConfig {
  /** Where the tools reach the hub — this same process, normally. */
  platformBaseUrl: string;
  agentId: string;
  /** Lets the execute tool trade. Absent, no caller can execute whatever key they hold. */
  operatorToken?: string;
  /** Named agent keys. The name is for logs and revocation; the key is the secret. */
  agentKeys: ReadonlyMap<string, string>;
  /** Serve the read-only tools to callers who present no key. */
  publicReads?: boolean;
  path?: string;
}

const MIN_KEY_LENGTH = 24;

const jsonRpcError = (res: Response, status: number, code: number, message: string): void => {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
};

export function mountStocksMcp(app: Express, cfg: StocksMcpConfig): void {
  for (const [name, key] of cfg.agentKeys) {
    if (key.length < MIN_KEY_LENGTH) throw new Error(`agent key "${name}" must be at least ${MIN_KEY_LENGTH} characters`);
  }
  if (cfg.agentKeys.size === 0 && !cfg.publicReads) {
    throw new Error("the MCP endpoint needs at least one agent key, or public reads enabled");
  }
  const path = cfg.path ?? "/mcp";
  // One client for callers who may trade, one that cannot: the read-only one
  // is never given the operator token, so no bug in tool registration can turn
  // an anonymous call into an execution.
  const trading = new QuaestorStocksClient({ baseUrl: cfg.platformBaseUrl, operatorToken: cfg.operatorToken });
  const readOnly = new QuaestorStocksClient({ baseUrl: cfg.platformBaseUrl });

  const handle = async (req: Request, res: Response, caller: string | null): Promise<void> => {
    // A JSON-RPC batch turns one HTTP request into any number of tool calls,
    // which makes every per-request limit above it meaningless.
    if (Array.isArray(req.body) || typeof req.body !== "object" || req.body === null) {
      jsonRpcError(res, 400, -32600, "send one JSON-RPC request per HTTP request; batches are not supported");
      return;
    }
    const server = new McpServer({ name: "quaestor-stocks", version: "0.2.0" }, { instructions: STOCK_SERVER_INSTRUCTIONS });
    registerStockTools(server, caller ? trading : readOnly, cfg.agentId, {
      allowExecute: caller !== null && Boolean(cfg.operatorToken),
    });
    // No session id: a remote agent may be load-balanced or restarted between
    // calls, and there is no state here worth making it resume.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[stocks-mcp] request failed:", safeMessage(error, 200));
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "internal error");
    }
  };

  // Identify the caller before reading a byte of the body: an unauthenticated
  // stranger should not get to make this process parse their JSON.
  const identify = (req: Request, res: Response, next: express.NextFunction): void => {
    const presented = bearer(req) ?? header(req, "x-api-key");
    if (presented === undefined) {
      if (cfg.publicReads) {
        res.locals.caller = null;
        return next();
      }
      jsonRpcError(res, 401, -32001, "Unauthorized: present the agent key as Authorization: Bearer <key> or X-API-Key");
      return;
    }
    // A key that is presented and wrong is refused outright. Falling back to
    // the public tier would hide a typo from the one person who needs to see it.
    const caller = matchKey(cfg.agentKeys, presented);
    if (!caller) {
      jsonRpcError(res, 401, -32001, "Unauthorized: the agent key was not recognised");
      return;
    }
    res.locals.caller = caller;
    next();
  };

  const perMinute = rateLimit({
    name: "MCP",
    windowMs: 60_000,
    limit: 90,
    // A keyed caller is counted by key, so one agent behind a shared egress IP
    // is not throttled by its neighbours; a stranger is counted by address.
    key: (req) => {
      const presented = bearer(req) ?? header(req, "x-api-key");
      const named = presented ? matchKey(cfg.agentKeys, presented) : null;
      return named ? `key:${named}` : `ip:${req.ip ?? "unknown"}`;
    },
  });

  app.post(
    path,
    perMinute,
    concurrencyLimit(8, "the MCP endpoint"),
    identify,
    // Tool inputs are a mint, an amount and an intent id.
    express.json({ limit: "16kb" }),
    (req, res) => void handle(req, res, (res.locals.caller as string | null) ?? null),
  );
  // Stateless servers have no stream to open and no session to end. Answering
  // GET with an SSE stream would pin a socket and a server for as long as the
  // caller cared to hold it.
  app.all(path, (_req, res) => {
    res.setHeader("Allow", "POST");
    jsonRpcError(res, 405, -32000, "Method not allowed: this endpoint is stateless, use POST");
  });

  console.log(
    `[stocks-mcp] mounted at ${path} — agent ${cfg.agentId}, `
    + `${cfg.agentKeys.size} agent key(s) [${[...cfg.agentKeys.keys()].join(", ")}], `
    + `public reads ${cfg.publicReads ? "on" : "off"}, `
    + (cfg.operatorToken ? "execute enabled for keyed callers" : "no operator token: nobody can execute"),
  );
}

/** The name of the key that matches, compared in constant time against every key. */
function matchKey(keys: ReadonlyMap<string, string>, presented: string): string | null {
  const a = Buffer.from(presented);
  let matched: string | null = null;
  for (const [name, key] of keys) {
    const b = Buffer.from(key);
    if (a.length === b.length && timingSafeEqual(a, b)) matched = name;
  }
  return matched;
}

function bearer(req: Request): string | undefined {
  const value = header(req, "authorization");
  if (!value) return undefined;
  return /^bearer\s+/i.test(value) ? value.replace(/^bearer\s+/i, "").trim() : undefined;
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first.trim() === "" ? undefined : first.trim();
}

/**
 * `STOCKS_MCP_API_KEYS=bankr:<key>,grok:<key>` names each key so one can be
 * revoked alone. `STOCKS_MCP_API_KEY` is the single-key form, named "default".
 */
function agentKeysFromEnv(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const pair of (process.env.STOCKS_MCP_API_KEYS ?? "").split(",")) {
    const at = pair.indexOf(":");
    if (at <= 0) continue;
    keys.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  const single = process.env.STOCKS_MCP_API_KEY?.trim();
  if (single) keys.set("default", single);
  return keys;
}

export function stocksMcpFromEnv(port: number): StocksMcpConfig | null {
  if (process.env.STOCKS_MCP_ENABLED !== "1") return null;
  const agentKeys = agentKeysFromEnv();
  const publicReads = process.env.STOCKS_MCP_PUBLIC_READS === "1";
  const short = [...agentKeys].find(([, key]) => key.length < MIN_KEY_LENGTH);
  if (short) {
    console.error(`[stocks-mcp] not mounted — agent key "${short[0]}" is shorter than ${MIN_KEY_LENGTH} characters`);
    return null;
  }
  if (agentKeys.size === 0 && !publicReads) {
    console.error("[stocks-mcp] not mounted — set STOCKS_MCP_API_KEY(S), or STOCKS_MCP_PUBLIC_READS=1 for a read-only endpoint");
    return null;
  }
  return {
    platformBaseUrl: process.env.STOCKS_MCP_PLATFORM_URL ?? `http://127.0.0.1:${port}`,
    agentId: process.env.SOLANA_STOCK_AGENT_ID ?? "solana-agent-1",
    operatorToken: process.env.SOLANA_STOCK_OPERATOR_TOKEN,
    agentKeys,
    publicReads,
    path: process.env.STOCKS_MCP_PATH ?? "/mcp",
  };
}
