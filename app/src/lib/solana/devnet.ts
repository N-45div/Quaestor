/**
 * The Solana side as deployed on devnet (deployments/solana-devnet.json).
 * Reads go through the stocks hub's devnet relay, which holds the key, and to
 * the public endpoint whenever the relay does not answer; a wallet's
 * transaction always goes to the public endpoint. No key is shipped in the page.
 */
export const DEVNET = {
  cluster: "devnet" as const,
  rpcUrl: "https://api.devnet.solana.com",
  /** Where a sent transaction's confirmation is watched. Named, so it never follows the reads to the relay. */
  wsUrl: "wss://api.devnet.solana.com/",
  /** The test USDC every governor here is funded in, and the Meteora curve is priced in. */
  usdcMint: "8HcqMLJJxoG3fAkgNk8Qm3Uv7oXhXLM8X5xE4FXZe3Cg",
  usdcDecimals: 6,
  dbcProgram: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  curvePool: "Ed6znHKEWLP1CbRgcbjLU9q21omye42PR9r1dfGSiGiM",
  curveMint: "GWVTYLHS74NFkk8fBVTx9DdsPs17bxFCwmoqZhBSiLvc",
  /** Meteora DAMM v2: where the curve graduates to. A governor allows it at registration, so graduation does not strand it. */
  dammProgram: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  /** The pool the curve graduated into on 8 Oct 2026. */
  graduatedPool: "5cjRrMdhjtwULU7KpzDzMfpxxE5osx5CXaj3dVvWnKUV",
  stubMint: "AAbNhnPT35sgR1KRrMzNhsuLjT2XPA2S83ABbJPCuAB1",
  /** The hosted stocks hub's own governor, which its MCP agents trade from. */
  houseGovernor: "7dWHCaSbywwN1XUTN1eB5yKBC6DFmue9GfS5nd1attQU",
  /** Where the agent command publishes each decision record, addressed by its keccak256. */
  ledgerUrl: "https://quaestor-hub.onrender.com",
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

/**
 * Trades the program refused, recorded in deployments/solana-devnet.json. A
 * refused trade writes no record, so the program's own accounts cannot list
 * them; these are the transactions, each failed with the error it names.
 */
export const REFUSALS: { code: string; errorNumber: number; signature: string; what: string }[] = [
  {
    code: "PriceAboveLimit",
    errorNumber: 6021,
    signature: "2NEwM28F5qHJh5r1HWHXp5cLdxaUo8PREookncMdJLDmCR5c6JBuK1oJ6w6Hv3bvgytoqjo8qtWsQWZPgktrmMrD",
    what: "A hijacked agent set its floor to one base unit and paid 1 USDC into a pool that gave back one hundred-millionth of a token. Every cap passed and the pool's swap succeeded; the owner's limit price of 400 USDC a token undid the whole trade.",
  },
  {
    code: "MinimumOutputNotMet",
    errorNumber: 6018,
    signature: "66UqTivorx2k4SD25d7DXrSTRsks83rdzEvBNKincxKCsSZPvpRH56pqDUBPEdCbKmJmLWFqCuNoSAZm6AUiwtKm",
    what: "Meteora's curve was told to accept any amount, and its swap succeeded. The governor measured what arrived, half the floor the trade committed to, and undid the whole trade.",
  },
  {
    code: "PerTradeCapExceeded",
    errorNumber: 6006,
    signature: "3VUUnGgTXXLAYrHjrAbCjByXnu963ELKp4XwAG6jUTpNusDWgz5m4Ah3p8GA5ypLfQD4WpmBrTL7i5nVNqPgspT4",
    what: "The agent asked to spend 501 USDC against the 500 USDC per-trade cap the owner had set then. Nothing left the vault.",
  },
  {
    code: "RouteOverspent",
    errorNumber: 6015,
    signature: "5uxYc3ZiQGSb7EQzfLJ8TTPPe7JFAcHKUehcsGg7buJZPvr8sHutmacdWypMwqKxRJKBjnpRbmPWDS6xJJ4ABwtT",
    what: "A route took more USDC from the vault than the trade authorised. The program compared the vault before and after the swap and reverted.",
  },
  {
    code: "StockBalanceDecreased",
    errorNumber: 6017,
    signature: "3BTXBRooQpY8VEmikzzykdX6CJXkdU4cGuXE6m7hZRDgXD8suQmPjtnpNKbxXeGxFCfEp2MxoT9sG4hoz9L22zZr",
    what: "A route delivered the stock, then took tokens back out of the position they landed in. The position ended lower than it started, so the program reverted.",
  },
];
