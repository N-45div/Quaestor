import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { QuaestorStocksClient } from "../sdk";

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export function registerStockTools(server: McpServer, client: QuaestorStocksClient, agentId: string): void {
  server.registerTool(
    "quaestor_stock_instruments",
    {
      description: "List the verified tokenized stocks this Quaestor endpoint can govern on Solana, including issuer, mint and transfer controls.",
      inputSchema: {},
    },
    async () => result({ instruments: await client.instruments() }),
  );

  server.registerTool(
    "quaestor_stock_market",
    {
      description: "Compare a tokenized stock with its underlying equity using signed Pyth Pro data, including freshness, publisher coverage, confidence and premium policy.",
      inputSchema: { instrument_mint: z.string().min(32) },
    },
    async ({ instrument_mint }) => result(await client.market(instrument_mint)),
  );

  server.registerTool(
    "quaestor_stock_quote",
    {
      description: "Get a short-lived Jupiter route for an exact USDC amount and approved stock mint. Amount is an integer with 6 USDC decimals.",
      inputSchema: {
        instrument_mint: z.string().min(32),
        amount_in_usdc: z.string().regex(/^\d+$/),
      },
    },
    async ({ instrument_mint, amount_in_usdc }) => result(await client.quote(agentId, instrument_mint, BigInt(amount_in_usdc))),
  );

  server.registerTool(
    "quaestor_stock_policy_preview",
    {
      description: "Preview the exact stock order against pause, operator, instrument, per-trade, epoch and vault rules without reserving or spending funds.",
      inputSchema: {
        quote_id: z.string().min(8),
        strategy: z.string().min(1).max(80),
        rationale: z.string().min(1).max(1000),
        intent_id: z.string().min(8).max(128).optional(),
        intent_expires_at: z.string().datetime({ offset: true }).optional(),
      },
    },
    async ({ quote_id, strategy, rationale, intent_id, intent_expires_at }) => {
      const request = orderRequest(agentId, quote_id, strategy, rationale, intent_id, intent_expires_at);
      return result({ request, preview: await client.preview(request) });
    },
  );

  server.registerTool(
    "quaestor_stock_execute",
    {
      description: "Execute a previously previewed stock purchase through Quaestor. Pass the exact intent_id and intent_expires_at returned by preview; the intent ID is also the idempotency key, so a retry returns the original order instead of trading twice.",
      inputSchema: {
        quote_id: z.string().min(8),
        strategy: z.string().min(1).max(80),
        rationale: z.string().min(1).max(1000),
        intent_id: z.string().min(8).max(128).optional(),
        intent_expires_at: z.string().datetime({ offset: true }).optional(),
      },
    },
    async ({ quote_id, strategy, rationale, intent_id, intent_expires_at }) => {
      const request = orderRequest(agentId, quote_id, strategy, rationale, intent_id, intent_expires_at);
      return result(await client.execute(request, request.intent_id));
    },
  );

  server.registerTool(
    "quaestor_stock_order",
    {
      description: "Read a stock order's current status and settlement or refusal evidence.",
      inputSchema: { order_id: z.string().min(8) },
    },
    async ({ order_id }) => result(await client.order(order_id)),
  );

  server.registerTool(
    "quaestor_stock_portfolio",
    {
      description: "Read the agent's public Solana stock balances, reserved USDC and current allowance consumption.",
      inputSchema: {},
    },
    async () => result(await client.portfolio(agentId)),
  );
}

function orderRequest(
  agentId: string,
  quoteId: string,
  strategy: string,
  rationale: string,
  intentId?: string,
  intentExpiresAt?: string,
) {
  return {
    agent_id: agentId,
    intent_id: intentId ?? `intent-${randomUUID()}`,
    quote_id: quoteId,
    intent_expires_at: intentExpiresAt ?? new Date(Date.now() + 15_000).toISOString(),
    decision: { strategy, rationale },
  };
}
