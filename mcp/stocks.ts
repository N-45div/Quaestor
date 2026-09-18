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
      description: "Discover tokenized public and private-market products on Solana with provider, mint provenance, rights notices and explicit execution status. Each instrument lists tradableVenues — the venues observed able to fill it. Routable is not permitted: an instrument is only tradeable when the owner has also approved it, and discovery-only products cannot be quoted or traded.",
      inputSchema: {},
    },
    async () => result(await client.instrumentCatalog()),
  );

  server.registerTool(
    "quaestor_stock_venues",
    {
      description: "List the venues this deployment can quote — Jupiter by default, others such as Meteora when configured. Pass one as `venue` to quaestor_stock_quote. You can choose among these; you cannot add one, and a venue the owner has not approved is refused at preview.",
      inputSchema: {},
    },
    async () => result(await client.venues()),
  );

  server.registerTool(
    "quaestor_stock_market",
    {
      description: "Read the price evidence the governor checks before a trade: how far the tokenized price sits from its reference, and whether that is inside the owner's policy. A trade whose evidence is out of policy is refused. Returns MARKET_GUARD_DISABLED when no price source is configured.",
      inputSchema: { instrument_mint: z.string().min(32) },
    },
    async ({ instrument_mint }) => result(await client.market(instrument_mint)),
  );

  server.registerTool(
    "quaestor_stock_quote",
    {
      description: "Get a short-lived route for an exact USDC amount and approved stock mint. Amount is an integer with 6 USDC decimals. The quote carries both the expected output and the minimum the route guarantees on-chain; a route that states no guaranteed minimum is refused. Optional `venue` picks the venue (see quaestor_stock_venues); omitted, the default venue is used.",
      inputSchema: {
        instrument_mint: z.string().min(32),
        amount_in_usdc: z.string().regex(/^\d+$/),
        venue: z.string().min(1).max(32).optional(),
      },
    },
    async ({ instrument_mint, amount_in_usdc, venue }) =>
      result(await client.quote(agentId, instrument_mint, BigInt(amount_in_usdc), venue)),
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
