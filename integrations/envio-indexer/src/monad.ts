/** What the handlers need to know of Quaestor's tokens on Monad testnet: symbols and decimals. */
export const BUDGET_DECIMALS = 6; // tUSDC

const SYMBOLS: Record<string, string> = {
  "0xf2fa4cf4209c7fc4a42e309ce01a6716b6a51b64": "tETH",
  "0x2ada61084aa0e9e92cd0308e74a1fbf74b30d9b0": "tTSLA",
  "0xf798f55d7c76385877e5a3a53302697e3474e750": "tNVDA",
  "0x0d281f410101629f0c115819418628938668386c": "tSPY",
  "0x360768e5ee90e54f70c0bfbd7bb465066d4c63fd": "tAAPL",
};

export const symbolOf = (token: string): string => SYMBOLS[token.toLowerCase()] ?? token.toLowerCase();

/** A bytes32 symbol, as the CRE receiver emits it, as text ("NVDA"). */
export const bytes32ToText = (hex: string): string => {
  const bytes = hex.replace(/^0x/, "").match(/../g) ?? [];
  return bytes.map((b) => parseInt(b, 16)).filter((c) => c !== 0).map((c) => String.fromCharCode(c)).join("");
};

export const DAY = 86_400;
