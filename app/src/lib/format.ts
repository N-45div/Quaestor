import { formatEther } from "viem";

/**
 * Format a native-token amount. Named `okb` when the project only ran on X
 * Layer; it is now live on three chains whose native units are OKB, USDC and
 * ETH, so the name is kept as an alias and `native()` is the one to use.
 */
export function okb(wei: bigint, digits = 4): string {
  const n = Number(formatEther(wei));
  if (n === 0) return "0";
  if (n < 0.0001) return "<0.0001";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** The same number, with the chain's own symbol attached. */
export function native(wei: bigint, symbol?: string, digits = 4): string {
  const n = okb(wei, digits);
  return symbol ? `${n} ${symbol}` : n;
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…`;
}

export function timeAgo(tsMs: number): string {
  const s = Math.max(1, Math.floor((Date.now() - tsMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const CATEGORY_NAMES = ["Data", "Inference", "Execution"] as const;
export const CATEGORY_KEYS = ["data", "inference", "execution"] as const;

/** Parse an agent metadataURI that may be a JSON blob with a name. */
export function agentName(agentId: bigint, metadataURI: string): string {
  try {
    const parsed = JSON.parse(metadataURI);
    if (parsed && typeof parsed.name === "string" && parsed.name.trim()) {
      return parsed.name.trim();
    }
  } catch {
    /* not JSON — fall through */
  }
  if (metadataURI.trim() && metadataURI.length <= 32) return metadataURI.trim();
  return `Agent #${agentId}`;
}
