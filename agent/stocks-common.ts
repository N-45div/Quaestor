import { randomUUID } from "node:crypto";
import type { QuaestorStocksClient } from "../sdk";
import type { StockDecisionRecord, StockOrderView } from "../stocks";

export interface StockAgentClient {
  market(instrumentMint: string): ReturnType<QuaestorStocksClient["market"]>;
  quote(agentId: string, instrumentMint: string, amountInUsdc: bigint): ReturnType<QuaestorStocksClient["quote"]>;
  preview(request: Parameters<QuaestorStocksClient["preview"]>[0]): ReturnType<QuaestorStocksClient["preview"]>;
  execute(request: Parameters<QuaestorStocksClient["execute"]>[0], idempotencyKey?: string): Promise<StockOrderView>;
}

export interface StockAgentAction {
  instrumentMint: string;
  amountInUsdc: bigint;
  decision: StockDecisionRecord;
}

export async function submitStockAction(client: StockAgentClient, agentId: string, action: StockAgentAction): Promise<StockOrderView | null> {
  const quote = await client.quote(agentId, action.instrumentMint, action.amountInUsdc);
  const intentId = `intent-${randomUUID()}`;
  const request = {
    agent_id: agentId,
    intent_id: intentId,
    quote_id: quote.quote_id,
    intent_expires_at: new Date(Math.min(Date.parse(quote.expires_at), Date.now() + 15_000)).toISOString(),
    decision: action.decision,
  };
  const preview = await client.preview(request);
  if (!preview.allowed) return null;
  return client.execute(request, intentId);
}
