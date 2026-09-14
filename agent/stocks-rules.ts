import * as dotenv from "dotenv";
import { QuaestorStocksClient } from "../sdk";
import { submitStockAction, type StockAgentClient } from "./stocks-common";

dotenv.config();

export interface RulesBasedSignal {
  discountBps: number;
  volatilityBps: number;
}

export async function runRulesBasedStockAgent(
  client: StockAgentClient,
  agentId: string,
  instrumentMint: string,
  amountInUsdc: bigint,
  signal: RulesBasedSignal,
) {
  if (signal.discountBps < 50 || signal.volatilityBps > 500) return null;
  return submitStockAction(client, agentId, {
    instrumentMint,
    amountInUsdc,
    decision: {
      strategy: "discount-and-volatility",
      rationale: `Buy: discount ${signal.discountBps}bps meets 50bps floor and volatility ${signal.volatilityBps}bps is within 500bps ceiling.`,
      inputs: signal as unknown as Record<string, unknown>,
    },
  });
}

async function main() {
  const client = new QuaestorStocksClient({
    baseUrl: process.env.STOCKS_API_URL ?? "http://localhost:8402",
    operatorToken: required("SOLANA_STOCK_OPERATOR_TOKEN"),
  });
  const order = await runRulesBasedStockAgent(
    client,
    process.env.SOLANA_STOCK_AGENT_ID ?? "solana-agent-1",
    required("SOLANA_STOCK_INSTRUMENT_MINT"),
    BigInt(process.env.SOLANA_STOCK_AMOUNT_USDC ?? "1000000"),
    {
      discountBps: Number(process.env.SOLANA_STOCK_DISCOUNT_BPS ?? 75),
      volatilityBps: Number(process.env.SOLANA_STOCK_VOLATILITY_BPS ?? 200),
    },
  );
  console.log(JSON.stringify(order ?? { status: "stood-down", reason: "rules did not authorize a buy" }, null, 2));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

if (require.main === module) void main().catch((error) => { console.error(error); process.exitCode = 1; });
