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
 * The chains the dashboard can point at. A `config.<key>.json` is deployed for
 * each; the bare `config.json` stays the default so existing links keep
 * working. These files already existed and were unreachable — nothing read
 * anything but `/config.json`, so the Arc and Base deployments were invisible
 * in the UI while being live on chain.
 */
export const CHAINS = [
  { key: "xlayerTestnet", label: "X Layer", file: "/config.json" },
  { key: "arcTestnet", label: "Arc", file: "/config.arcTestnet.json" },
  { key: "baseSepolia", label: "Base", file: "/config.baseSepolia.json" },
  { key: "sepolia", label: "Ethereum Sepolia", file: "/config.sepolia.json" },
] as const;

export type ChainKey = (typeof CHAINS)[number]["key"];

/** `#/app?chain=arcTestnet` — the query sits inside the hash for a hash router. */
export function chainFromLocation(): ChainKey {
  const hash = window.location.hash;
  const q = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : window.location.search;
  const want = new URLSearchParams(q).get("chain");
  const hit = CHAINS.find((c) => c.key === want);
  return hit ? hit.key : "xlayerTestnet";
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
  if (!res.ok) {
    if (entry.file === "/config.json") throw new Error("config.json missing");
    return loadConfig("xlayerTestnet");
  }
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
