export interface AppConfig {
  network: string;
  chainId: number;
  /** Native token symbol for this chain. On Arc this is USDC — the gas token
   *  IS the dollar, which is the whole reason caps are dollar caps there. */
  symbol?: string;
  /** Human label for the chain switcher. */
  label?: string;
  rpcUrl: string;
  /** e.g. https://www.oklink.com/xlayer-test/tx/ — empty on localhost */
  explorerTx: string;
  explorerAddr: string;
  /** Decision-record ledger base URL; empty when no ledger is available. */
  decisionLedgerUrl?: string;
  startBlock: number;
  /** Real money: the UI labels it, and never offers a faucet or demo tokens. */
  mainnet?: boolean;
  /** 2 for QuaestorV2, which swaps through any allowed venue; absent means the original. */
  governorVersion?: 1 | 2;
  /** The subgraph indexing this governor and its log, where there is one. */
  subgraphUrl?: string;
  contracts: {
    Quaestor: `0x${string}`;
    /** Where decision records are published for good (QuaestorV2 deployments). */
    QuaestorLog?: `0x${string}`;
    /** The demo AMM and its test tokens, on the testnets only. */
    QuaestorDEX?: `0x${string}`;
    qUSD?: `0x${string}`;
    qBTC?: `0x${string}`;
  };
  /** Venues and instruments the deployment's agent is allowed, for display. */
  venues?: { name: string; address: `0x${string}` }[];
  instruments?: { symbol: string; address: `0x${string}`; decimals: number }[];
}

/**
 * The chain the explorer's governor side reads: QuaestorV2 on Base mainnet.
 *
 * The testnet deployments (X Layer, Arc, Base Sepolia, Ethereum Sepolia) are
 * still on chain and their config files still ship, but they are no longer on
 * the switch: what a visitor sees is the deployment that moves real money.
 */
export const CHAINS = [
  { key: "base", label: "Base", file: "/config.base.json" },
] as const;

export type ChainKey = (typeof CHAINS)[number]["key"];

/** `#/app?chain=arcTestnet` — the query sits inside the hash for a hash router. */
export function chainFromLocation(): ChainKey {
  const hash = window.location.hash;
  const q = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : window.location.search;
  const want = new URLSearchParams(q).get("chain");
  const hit = CHAINS.find((c) => c.key === want);
  return hit ? hit.key : "base";
}

const cache = new Map<string, AppConfig>();

export async function loadConfig(chain?: ChainKey): Promise<AppConfig> {
  const key = chain ?? chainFromLocation();
  const hit = cache.get(key);
  if (hit) return hit;
  const entry = CHAINS.find((c) => c.key === key) ?? CHAINS[0];
  const res = await fetch(entry.file);
  // A missing per-chain file must not take the dashboard down; fall back to the
  // default chain so the UI keeps working on a partial deploy.
  if (!res.ok) throw new Error(`${entry.file} missing`);
  const cfg = (await res.json()) as AppConfig;
  cache.set(key, cfg);
  return cfg;
}

export function txUrl(cfg: AppConfig, hash: string): string | null {
  return cfg.explorerTx ? `${cfg.explorerTx}${hash}` : null;
}

export function addrUrl(cfg: AppConfig, addr: string): string | null {
  return cfg.explorerAddr ? `${cfg.explorerAddr}${addr}` : null;
}
