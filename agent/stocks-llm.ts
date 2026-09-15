import * as dotenv from "dotenv";
import { z } from "zod";
import { QuaestorStocksClient } from "../sdk";
import { submitStockAction, type StockAgentClient } from "./stocks-common";

dotenv.config();

const planSchema = z.object({
  symbol: z.string(),
  amount_usdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
  rationale: z.string().min(1).max(500),
});

export interface StockPlanner {
  plan(context: Record<string, unknown>, symbols: string[]): Promise<z.infer<typeof planSchema> | null>;
}

export async function runLlmStockAgent(
  client: StockAgentClient,
  planner: StockPlanner,
  agentId: string,
  instruments: { symbol: string; mint: string }[],
  context: Record<string, unknown>,
) {
  const plan = await planner.plan(context, instruments.map((instrument) => instrument.symbol));
  if (!plan) return null;
  const instrument = instruments.find((candidate) => candidate.symbol === plan.symbol);
  if (!instrument) throw new Error("planner selected an instrument outside the approved universe");
  const amountInUsdc = decimalUsdc(plan.amount_usdc);
  return submitStockAction(client, agentId, {
    instrumentMint: instrument.mint,
    amountInUsdc,
    decision: {
      strategy: "llm-stock-selector",
      rationale: plan.rationale,
      model: process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4.1-flash",
      inputs: context,
    },
  });
}

export class OpenRouterStockPlanner implements StockPlanner {
  constructor(private readonly apiKey: string, private readonly model = "deepseek/deepseek-v4.1-flash") {}

  async plan(context: Record<string, unknown>, symbols: string[]) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: "system",
            content: `Choose at most one approved stock. Reply only with JSON {"symbol":"one of ${symbols.join(",")}","amount_usdc":"decimal USDC","rationale":"under 500 chars"}, or null to stand down.`,
          },
          { role: "user", content: JSON.stringify(context) },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`OpenRouter failed (${response.status})`);
    const body = await response.json() as { choices?: { message?: { content?: string } }[] };
    const raw = body.choices?.[0]?.message?.content?.trim();
    if (!raw || raw === "null") return null;
    return planSchema.parse(JSON.parse(raw));
  }
}

function decimalUsdc(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

async function main() {
  const client = new QuaestorStocksClient({
    baseUrl: process.env.STOCKS_API_URL ?? "http://localhost:8402",
    operatorToken: required("SOLANA_STOCK_OPERATOR_TOKEN"),
  });
  const instruments = (await client.instruments()).map(({ symbol, mint }) => ({ symbol, mint }));
  const markets = await Promise.all(instruments.map(async (instrument) => ({
    symbol: instrument.symbol,
    assessment: await client.market(instrument.mint),
  })));
  const planner = new OpenRouterStockPlanner(required("OPENROUTER_API_KEY"), process.env.OPENROUTER_MODEL);
  const order = await runLlmStockAgent(
    client,
    planner,
    process.env.SOLANA_STOCK_AGENT_ID ?? "solana-agent-1",
    instruments,
    {
      thesis: process.env.SOLANA_STOCK_THESIS ?? "Prefer broad exposure when risk is elevated.",
      pyth_markets: markets,
    },
  );
  console.log(JSON.stringify(order ?? { status: "stood-down", reason: "planner chose no trade" }, null, 2));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

if (require.main === module) void main().catch((error) => { console.error(error); process.exitCode = 1; });
