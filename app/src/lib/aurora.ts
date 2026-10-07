/**
 * Aurora Intents (on NEAR Intents' 1Click): bring USDC or ETH from another chain to Monad, priced
 * and routed by Aurora's solvers. A quote returns a deposit address on the origin chain; the user
 * sends to it, and the destination asset is delivered to the recipient on Monad (mainnet, chain 143).
 *
 * The app key is Aurora's public, per-app key ("not confidential", by Aurora's docs); it is set at
 * build time as VITE_AURORA_APP_KEY and the panel is hidden without it.
 */
export const AURORA_KEY = (import.meta.env.VITE_AURORA_APP_KEY as string | undefined) ?? "";
const BASE = "https://intents-api.aurora.dev";

export interface Origin { key: string; label: string; chain: string; symbol: string; assetId: string; decimals: number; evm: boolean }

export const ORIGINS: Origin[] = [
  { key: "base-usdc", label: "USDC on Base", chain: "base", symbol: "USDC", assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6, evm: true },
  { key: "arb-usdc", label: "USDC on Arbitrum", chain: "arb", symbol: "USDC", assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", decimals: 6, evm: true },
  { key: "eth-usdc", label: "USDC on Ethereum", chain: "eth", symbol: "USDC", assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", decimals: 6, evm: true },
  { key: "sol-usdc", label: "USDC on Solana", chain: "sol", symbol: "USDC", assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", decimals: 6, evm: false },
  { key: "base-eth", label: "ETH on Base", chain: "base", symbol: "ETH", assetId: "nep141:base.omft.near", decimals: 18, evm: true },
  { key: "arb-eth", label: "ETH on Arbitrum", chain: "arb", symbol: "ETH", assetId: "nep141:arb.omft.near", decimals: 18, evm: true },
];

export const DESTINATIONS = [
  { key: "usdc", label: "USDC: the agent's budget", symbol: "USDC", assetId: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx" },
  { key: "mon", label: "MON: the agent's gas", symbol: "MON", assetId: "nep245:v2_1.omni.hot.tg:143_11111111111111111111" },
];

export interface Quote {
  depositAddress?: string;
  amountInFormatted: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  minAmountIn: string;
  timeEstimate: number;
  deadline?: string;
}

export type SwapStatus = "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";

export interface StatusView { status: SwapStatus; updatedAt: string; swapDetails?: { destinationChainTxHashes?: { hash: string; explorerUrl?: string }[]; amountOutFormatted?: string } }

const call = async <T,>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${BASE}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(json.message ?? `Aurora answered ${res.status}.`);
  return json;
};

/** Whether NEAR Intents has paused a chain, and since when: Aurora's own incident feed. */
export async function chainPause(chain: string): Promise<{ since: string } | null> {
  const r = await call<{ incidents: { scopeType: string; scopeValue: string; status: string; createdAt: string }[] }>("GET", `/api/incidents/${AURORA_KEY}`);
  const hit = r.incidents.filter((i) => i.scopeType === "chain" && i.scopeValue === chain && i.status === "active").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  return hit ? { since: hit.createdAt } : null;
}

/** A quote: `dry` prices the route; not dry also opens a deposit address for this transfer. */
export async function quote(p: { origin: Origin; destinationAssetId: string; amount: bigint; recipient: string; refundTo: string; dry: boolean }): Promise<Quote> {
  const r = await call<{ quote: Quote }>("POST", `/api/quote/${AURORA_KEY}`, {
    dry: p.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: p.origin.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: p.destinationAssetId,
    amount: p.amount.toString(),
    recipient: p.recipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo: p.refundTo,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  return r.quote;
}

/** Tell Aurora the deposit was sent, so it is picked up sooner. */
export const submitDeposit = (depositAddress: string, txHash: string) => call<unknown>("POST", `/api/deposit/submit/${AURORA_KEY}`, { depositAddress, txHash });

export const status = (depositAddress: string) => call<StatusView>("GET", `/api/status/${AURORA_KEY}?depositAddress=${encodeURIComponent(depositAddress)}`);

/** "12.5" in base units, or null if it is not an amount. */
export function units(text: string, decimals: number): bigint | null {
  const t = text.trim();
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0"));
}
