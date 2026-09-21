/**
 * The Solana side as deployed on devnet (deployments/solana-devnet.json).
 * Reads go to the public devnet endpoint: it is the viewer's own request, so
 * no key is needed and none is shipped in the page.
 */
export const DEVNET = {
  cluster: "devnet" as const,
  rpcUrl: "https://api.devnet.solana.com",
  /** The test USDC every governor here is funded in, and the Meteora curve is priced in. */
  usdcMint: "8HcqMLJJxoG3fAkgNk8Qm3Uv7oXhXLM8X5xE4FXZe3Cg",
  usdcDecimals: 6,
  dbcProgram: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  curvePool: "Ed6znHKEWLP1CbRgcbjLU9q21omye42PR9r1dfGSiGiM",
  curveMint: "GWVTYLHS74NFkk8fBVTx9DdsPs17bxFCwmoqZhBSiLvc",
  stubMint: "AAbNhnPT35sgR1KRrMzNhsuLjT2XPA2S83ABbJPCuAB1",
  /** The hosted stocks hub's own governor, which its MCP agents trade from. */
  houseGovernor: "7dWHCaSbywwN1XUTN1eB5yKBC6DFmue9GfS5nd1attQU",
};

/** Names for the mints this deployment knows; anything else shows its address. */
export const MINT_NAMES: Record<string, string> = {
  [DEVNET.usdcMint]: "test USDC",
  [DEVNET.curveMint]: "qAAPLdemo",
  [DEVNET.stubMint]: "dAAPLx",
};

/** The tokens a governor here may buy, whose positions name each trade's token. */
export const STOCK_MINTS = [DEVNET.curveMint, DEVNET.stubMint];

/** Names for the venues this deployment knows. */
export const VENUE_NAMES: Record<string, string> = {
  [DEVNET.dbcProgram]: "Meteora DBC curve",
  "3RTVgJ1jXnUZTkaQwvgZiy98vfFqHxHr9Ey8CXyX9imS": "Router stub (test venue)",
};

export const explorerUrl = (kind: "address" | "tx", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=${DEVNET.cluster}`;
