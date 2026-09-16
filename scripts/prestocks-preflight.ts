import * as dotenv from "dotenv";
import { PreStocksRegistry, SolanaRpcMintVerifier } from "../stocks";

dotenv.config();

async function main(): Promise<void> {
  const registry = new PreStocksRegistry(new SolanaRpcMintVerifier(
    process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  ));
  const instruments = await registry.instruments();
  console.log(JSON.stringify({
    checked_at: new Date().toISOString(),
    provider: registry.provider,
    count: instruments.length,
    instruments: instruments.map((instrument) => ({
      symbol: instrument.symbol,
      name: instrument.name,
      mint: instrument.mint,
      token_program: instrument.tokenProgram,
      decimals: instrument.decimals,
      execution_status: instrument.executionStatus,
      provider_reported_supply: instrument.referenceData?.providerReportedSupply,
      onchain_mint_supply: instrument.referenceData?.onchainMintSupply,
      mark_price_usd: instrument.referenceData?.markPriceUsd,
      token_price_usd: instrument.referenceData?.tokenPriceUsd,
      premium_bps: instrument.referenceData?.premiumBps,
    })),
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
