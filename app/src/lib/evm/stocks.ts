import {
  createWalletClient,
  custom,
  defineChain,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
  type Chain,
  type Hex,
  type WalletClient,
} from "viem";
import { stocksBase } from "../stocks";
import type { WalletOption } from "../wallet";

/**
 * The Stock Token governor on EVM chains, as the hub serves it (/v1/evm) and
 * as the owner's wallet signs it. Every read here is the hub reading the
 * chain on request; the only thing that holds a key is the owner's wallet.
 */

export interface EvmInstrument { symbol: string; name: string; address: Address; decimals: number; feed?: Address; fees: number[] }
export interface EvmVenue { kind: string; label: string; router: Address; quoter: Address; factory: Address }
export interface EvmNetwork {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;
  testnet: boolean;
  factory: Address;
  factoryBlock: number;
  budget: { symbol: string; address: Address; decimals: number; feed?: Address; mintable?: boolean };
  venues: EvmVenue[];
  instruments: EvmInstrument[];
  gasSymbol: string;
  agentGas: string;
  assetNoun?: "share" | "token";
  demo: { governor: Address; stock: string; kinds: string[] } | null;
}

/** The chain's own words: shares of stocks on Uniswap, or tokens on Kuru. */
export function words(n: EvmNetwork) {
  const token = n.assetNoun === "token";
  const venue = n.venues[0]?.kind === "kuru" ? "Kuru" : "Uniswap";
  return {
    unit: token ? "token" : "share",
    Assets: token ? "Tokens" : "Stocks",
    assets: token ? "tokens" : "stocks",
    Asset: token ? "Token" : "Stock",
    venue,
    route: venue === "Kuru" ? "Kuru's Router" : "Uniswap's router",
    attackerVenue: venue === "Kuru" ? "an order book its attacker opened, with one ask at a price it chose" : "a pool its attacker opened at a price it chose",
    /** On a testnet: what the chain provides and what Quaestor brought, so nothing here passes for a real market. */
    testnetNote: !n.testnet
      ? null
      : venue === "Kuru"
        ? "The Chainlink ETH/USD feed is Chainlink’s own. The Kuru market, its two test tokens and the only maker quoting it are Quaestor’s, because Kuru’s own testnet market delivers native MON in lots of 200."
        : "Robinhood’s faucet provides the Stock Tokens. The rest is Quaestor’s: tUSDG, a test dollar; Uniswap v3 deployed from Uniswap’s own bytecode; and a feed per stock with Chainlink’s interface, holding the price the hub copies from Chainlink’s mainnet feed every ten minutes. Nobody arbitrages a testnet pool, so the hub trades each one back to its feed every five minutes.",
  };
}

export interface GovernorRow { address: Address; owner: Address; operator: Address; suspended: boolean; demo: boolean }

export interface GovernorView {
  address: Address;
  owner: Address;
  operator: Address;
  guardian: Address;
  suspended: boolean;
  budgetToken: Address;
  budget: string;
  perTradeCap: string;
  epochCap: string;
  epochLength: number;
  spentThisEpoch: string;
  remaining: string;
  epochEndsAt: number;
  venues: { address: Address; label: string; allowed: boolean }[];
  instruments: { symbol: string; address: Address; allowed: boolean; held: string; limitPrice: string; guard: { feed: Address; maxDeviationBps: number; maxStaleness: number } | null }[];
  prices: { stock: string; chainlink: { price: string; updatedAt: number } | null }[];
  demo: boolean;
}

export interface TradeRow {
  tx: Hex;
  block: number;
  governor: Address;
  intentId: Hex;
  venue: Address;
  stock: string;
  token: Address;
  spent: string;
  received: string;
  pricePerShare: string;
  decisionHash: Hex;
  epochSpent: string;
}

export interface TradeView {
  tx: Hex;
  status: number;
  block: number;
  at?: number;
  governor: Address;
  operator?: Address;
  trade: Omit<TradeRow, "tx" | "block" | "governor"> | null;
}

export interface RefusalResult {
  kind: string;
  network: string;
  governor: Address;
  tx: Hex;
  explorer: string;
  refused: string;
  detail: string;
  meaning: string;
  budgetBefore: string;
  budgetAfter: string;
  sharesBefore: string;
  sharesAfter: string;
  what: string;
  plain?: string;
}

async function get<T>(path: string, timeoutMs = 75_000): Promise<T> {
  // A free host may be waking, which takes up to a minute.
  const res = await fetch(`${stocksBase()}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? body?.error?.message ?? `The hub answered ${res.status}.`);
  return body as T;
}

export const fetchNetworks = () => get<{ networks: EvmNetwork[] }>("/v1/evm").then((r) => r.networks);
export const fetchGovernors = (net: string) => get<{ governors: GovernorRow[] }>(`/v1/evm/${net}/governors`).then((r) => r.governors);
export const fetchGovernor = (net: string, address: string) => get<GovernorView>(`/v1/evm/${net}/governors/${address}`);
export interface TradeFeed { trades: TradeRow[]; source?: "envio-hypersync" | "rpc" }
export const fetchTrades = (net: string, governor?: string) =>
  get<TradeFeed>(`/v1/evm/${net}/trades${governor ? `?governor=${governor}` : ""}`);
export const sourceLabel = (s?: string) => (s === "envio-hypersync" ? "indexed by Envio HyperSync" : "read from the chain");
export const fetchTrade = (net: string, tx: string) => get<TradeView>(`/v1/evm/${net}/trades/${tx}`);

export async function sendRefusal(net: string, kind: string): Promise<RefusalResult> {
  const res = await fetch(`${stocksBase()}/v1/evm/${net}/demo/refusal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 429) throw new Error("You have tried this a few times already; the hub allows four every ten minutes.");
  if (!res.ok) throw new Error(body?.message ?? body?.error?.message ?? `The hub answered ${res.status}.`);
  return body as RefusalResult;
}

/** The trade's reason, fetched from the ledger and re-hashed here against what the chain committed to. */
export type RecordState =
  | { kind: "loading" }
  | { kind: "verified"; raw: string }
  | { kind: "mismatch" }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export const LEDGER_URL = "https://quaestor-hub.onrender.com";

export async function fetchRecord(hash: string): Promise<RecordState> {
  try {
    const res = await fetch(`${LEDGER_URL}/decisions/${hash}`, { signal: AbortSignal.timeout(75_000) });
    if (res.status === 404) return { kind: "missing" };
    if (!res.ok) return { kind: "error", message: `The ledger answered ${res.status}.` };
    const raw = await res.text();
    return keccak256(toBytes(raw)).toLowerCase() === hash.toLowerCase() ? { kind: "verified", raw } : { kind: "mismatch" };
  } catch (e) {
    return { kind: "error", message: `The ledger did not answer (${(e as Error).message}).` };
  }
}

// ------------------------------------------------------------------ amounts

/** A decimal string such as "12.5" in base units, or null if it is not one. */
export function parseUnits(text: string, decimals: number): bigint | null {
  const t = text.trim();
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0"));
}

/** A decimal string from the hub, shown with at most `digits` decimals. */
export function show(value: string | undefined, digits = 2): string {
  if (value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: Math.min(digits, 2) });
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const explorerTx = (n: EvmNetwork, hash: string) => `${n.explorer}/tx/${hash}`;
export const explorerAddress = (n: EvmNetwork, address: string) => `${n.explorer}/address/${address}`;
export const epochLabel = (seconds: number) => (seconds === 3600 ? "hour" : seconds === 86_400 ? "day" : seconds === 604_800 ? "week" : `${seconds}s`);

// ------------------------------------------------------------------ the owner's wallet

export const FACTORY_ABI = parseAbi([
  "struct GuardSetup { address token; address feed; uint16 maxDeviationBps; uint32 maxStaleness; }",
  "struct Setup { address operator; address budgetToken; uint64 epochLength; uint128 perTradeCap; uint128 epochCap; address[] venues; bytes16[] labels; address[] tokens; uint128[] maxPrices; GuardSetup[] guards; uint256 deposit; }",
  "function createGovernor(Setup s) payable returns (address governor)",
  "function governorsOf(address owner) view returns (address[])",
  "event GovernorCreated(address indexed governor, address indexed owner, address indexed operator, address budgetToken, uint256 deposit)",
]);

export const GOVERNOR_ABI = parseAbi([
  "function setPolicy(uint128 perTradeCap, uint128 epochCap, uint64 epochLength)",
  "function setOperator(address operator)",
  "function setSuspended(bool suspended)",
  "function setPriceLimit(address token, uint128 maxPrice)",
  "function setPriceGuard(address token, address feed, uint16 maxDeviationBps, uint32 maxStaleness)",
  "function withdraw(address token, uint256 amount, address to)",
]);

export const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export function chainOf(n: EvmNetwork): Chain {
  return defineChain({
    id: n.chainId,
    name: n.name,
    nativeCurrency: { name: n.gasSymbol, symbol: n.gasSymbol, decimals: 18 },
    rpcUrls: { default: { http: [n.rpcUrl] } },
    blockExplorers: { default: { name: "Explorer", url: n.explorer } },
    testnet: n.testnet,
  });
}

/** Connect the owner's wallet on this chain, adding the chain to it if it has never seen it. */
export async function connectOwner(n: EvmNetwork, wallet: WalletOption | undefined): Promise<{ client: WalletClient; account: Address }> {
  const provider = wallet?.provider;
  if (!provider) throw new Error("No browser wallet found. Install one such as MetaMask, Rabby or Coinbase Wallet.");
  const accounts: string[] = await provider.request({ method: "eth_requestAccounts" });
  if (!accounts.length) throw new Error("The wallet returned no accounts.");
  const hexId = `0x${n.chainId.toString(16)}`;
  const current: string = await provider.request({ method: "eth_chainId" });
  if (parseInt(current, 16) !== n.chainId) {
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (e) {
      if ((e as { code?: number }).code !== 4902) throw e;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hexId, chainName: n.name, nativeCurrency: { name: n.gasSymbol, symbol: n.gasSymbol, decimals: 18 }, rpcUrls: [n.rpcUrl], blockExplorerUrls: [n.explorer] }],
      });
    }
  }
  const client = createWalletClient({ chain: chainOf(n), transport: custom(provider) });
  return { client, account: accounts[0] as Address };
}

/** A wallet's refusal in words a person can act on. */
export function explainWalletError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; code?: number; cause?: { code?: number } };
  if (err.code === 4001 || err.cause?.code === 4001 || /rejected|denied/i.test(err.message ?? "")) return "The wallet request was declined; nothing was sent.";
  const m = err.shortMessage ?? err.message ?? String(e);
  return m.length > 220 ? `${m.slice(0, 220)}…` : m;
}
