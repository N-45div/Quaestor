import { decisionHash, StockGovernor } from "../stocks";
import type { JupiterQuote, StockTradeIntent } from "../stocks";

/**
 * Day 1 proof: the same governor accepts one approved trade and refuses the
 * next one before a chain executor is reached. This uses a deliberately
 * injected executor; it is a policy proof, not a claim of a live Solana fill.
 */
async function main() {
  let now = 1_700_000_000;
  const governor = new StockGovernor({
    owner: "owner:solana",
    operator: "operator:solana",
    usdcMint: "USDC_MINT",
    instruments: [{
      symbol: "AAPL.US",
      issuer: "backpack-securities",
      mint: "AAPL_MINT",
      usdcMint: "USDC_MINT",
      decimals: 6,
      enabled: true,
    }],
    policy: {
      epochCapUsdc: 100n,
      perTradeCapUsdc: 60n,
      epochLengthSeconds: 3600,
      approvedMints: new Set(["AAPL_MINT"]),
    },
    now: () => now,
  });
  governor.depositUsdc("owner:solana", 250n);

  const base = {
    intentId: "day1-allowed",
    agentId: "agent-1",
    operator: "operator:solana",
    instrumentMint: "AAPL_MINT",
    inputMint: "USDC_MINT",
    amountInUsdc: 50n,
    minOutput: 4n,
    quoteId: "quote-1",
    quoteExpiresAt: now + 30,
  } satisfies Omit<StockTradeIntent, "decisionHash">;
  const intent: StockTradeIntent = { ...base, decisionHash: decisionHash(base) };
  const quote: JupiterQuote = {
    quoteId: "quote-1",
    inputMint: "USDC_MINT",
    outputMint: "AAPL_MINT",
    inAmount: 50n,
    outAmount: 5n,
    route: "jupiter-route-1",
    expiresAt: now + 30,
  };

  const receipt = await governor.execute(intent, quote, {
    execute: async () => ({ txSignature: "solana-proof-tx", actualOutput: 5n }),
  });
  console.log("ALLOWED", JSON.stringify({ ...receipt, inputAmount: receipt.inputAmount.toString(), outputAmount: receipt.outputAmount.toString(), spentAfter: receipt.spentAfter.toString() }));

  const refused = { ...intent, intentId: "day1-refused", amountInUsdc: 61n };
  try {
    await governor.execute(refused, { ...quote, inAmount: 61n }, {
      execute: async () => ({ txSignature: "must-not-run", actualOutput: 6n }),
    });
  } catch (error) {
    console.log("REFUSED", JSON.stringify({ code: (error as { code?: string }).code, message: (error as Error).message }));
  }
  now += 1;
  console.log("STATUS", JSON.stringify({ ...governor.status(), usdcBalance: governor.status().usdcBalance.toString(), spent: governor.status().spent.toString() }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
