export interface AppConfig {
  network: string;
  chainId: number;
  rpcUrl: string;
  /** e.g. https://www.oklink.com/xlayer-test/tx/ — empty on localhost */
  explorerTx: string;
  explorerAddr: string;
  startBlock: number;
  contracts: {
    Quaestor: `0x${string}`;
    QuaestorDEX: `0x${string}`;
    qUSD: `0x${string}`;
    qBTC: `0x${string}`;
  };
}

let cached: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (cached) return cached;
  const res = await fetch("/config.json");
  if (!res.ok) throw new Error("config.json missing");
  cached = (await res.json()) as AppConfig;
  return cached;
}

export function txUrl(cfg: AppConfig, hash: string): string | null {
  return cfg.explorerTx ? `${cfg.explorerTx}${hash}` : null;
}

export function addrUrl(cfg: AppConfig, addr: string): string | null {
  return cfg.explorerAddr ? `${cfg.explorerAddr}${addr}` : null;
}
