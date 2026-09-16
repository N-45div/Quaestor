import type { StockInstrument } from "./types";

export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/**
 * Small, reviewed mainnet universe for the first Quaestor Stocks integration.
 * Mints and ISINs come from xStocks' public asset API. Decimals, token program
 * and extensions are independently checked through Solana getAccountInfo.
 */
export const VERIFIED_XSTOCKS: readonly StockInstrument[] = Object.freeze([
  {
    symbol: "AAPLx",
    name: "Apple xStock",
    provider: "xstocks",
    assetClass: "public-equity-exposure",
    executionStatus: "enabled",
    underlyingSymbol: "AAPL",
    issuer: "Backed Assets (JE) Limited",
    isin: "CH1436219187",
    mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    usdcMint: SOLANA_USDC_MINT,
    decimals: 8,
    enabled: true,
    network: "solana-mainnet",
    tokenProgram: TOKEN_2022_PROGRAM,
    transferRules: ["pausable", "permanent-delegate", "scaled-ui-amount", "confidential-transfer-manual-approval"],
    sourceUrl: "https://api.xstocks.fi/api/v2/public/assets",
    jurisdictionNotice: "Not available in the United States, United Kingdom or other restricted jurisdictions; eligibility is determined by the issuer and distribution venue.",
    legalUrl: "https://assets.backed.fi/legal-documentation",
    rightsNotice: "Tokenized exposure governed by the issuer's product terms; it is not a direct share held through Quaestor.",
  },
  {
    symbol: "NVDAx",
    name: "NVIDIA xStock",
    provider: "xstocks",
    assetClass: "public-equity-exposure",
    executionStatus: "enabled",
    underlyingSymbol: "NVDA",
    issuer: "Backed Assets (JE) Limited",
    isin: "CH1436219195",
    mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    usdcMint: SOLANA_USDC_MINT,
    decimals: 8,
    enabled: true,
    network: "solana-mainnet",
    tokenProgram: TOKEN_2022_PROGRAM,
    transferRules: ["pausable", "permanent-delegate", "scaled-ui-amount", "confidential-transfer-manual-approval"],
    sourceUrl: "https://api.xstocks.fi/api/v2/public/assets",
    jurisdictionNotice: "Not available in the United States, United Kingdom or other restricted jurisdictions; eligibility is determined by the issuer and distribution venue.",
    legalUrl: "https://assets.backed.fi/legal-documentation",
    rightsNotice: "Tokenized exposure governed by the issuer's product terms; it is not a direct share held through Quaestor.",
  },
  {
    symbol: "SPYx",
    name: "SPDR S&P 500 ETF xStock",
    provider: "xstocks",
    assetClass: "public-equity-exposure",
    executionStatus: "enabled",
    underlyingSymbol: "SPY",
    issuer: "Backed Assets (JE) Limited",
    isin: "CH1436219716",
    mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    usdcMint: SOLANA_USDC_MINT,
    decimals: 8,
    enabled: true,
    network: "solana-mainnet",
    tokenProgram: TOKEN_2022_PROGRAM,
    transferRules: ["pausable", "permanent-delegate", "scaled-ui-amount", "confidential-transfer-manual-approval"],
    sourceUrl: "https://api.xstocks.fi/api/v2/public/assets",
    jurisdictionNotice: "Not available in the United States, United Kingdom or other restricted jurisdictions; eligibility is determined by the issuer and distribution venue.",
    legalUrl: "https://assets.backed.fi/legal-documentation",
    rightsNotice: "Tokenized exposure governed by the issuer's product terms; it is not a direct ETF share held through Quaestor.",
  },
] satisfies StockInstrument[]);
