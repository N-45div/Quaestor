/**
 * quaestor-evm: the one command an agent runs to buy tokenized stocks under a
 * Quaestor governor on an EVM chain: Robinhood Chain first, Monad next.
 *
 *   node quaestor-evm.mjs keygen                       make this agent's key (never printed)
 *   node quaestor-evm.mjs register                     the link the owner opens and signs
 *   node quaestor-evm.mjs whoami                       this key, its gas, the governors naming it
 *   node quaestor-evm.mjs status                       caps, spend, budget, holdings, prices
 *   node quaestor-evm.mjs quote --stock AAPL --usdg 5  Uniswap's fill against Chainlink's price
 *   node quaestor-evm.mjs buy --stock AAPL --usdg 5 --reason "..."
 *   node quaestor-evm.mjs check                        settle a buy that was sent but not confirmed
 *
 * The owner's governor names this key as its operator, and the key can do one
 * thing: ask the governor to buy an approved Stock Token through an approved
 * venue. The governor lends the venue exactly the trade's amount and measures
 * what left and what arrived, and reverts a fill over the owner's limit price
 * or too far over Chainlink's price. This command holds itself to the same
 * checks before it signs anything, so a refusal usually costs no gas at all.
 *
 * Every command prints one JSON object. A refusal exits 2 and says what was
 * refused; anything else that fails exits 1.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ethers } from "ethers";
import {
  ERC20_ABI,
  FACTORY_ABI,
  GOVERNOR_ABI,
  NETWORKS,
  bestQuote,
  budgetOf,
  budgetsOf,
  EVM_REFUSALS,
  commitDecision,
  explorerAddress,
  explorerTx,
  fillPrice,
  instrumentOf,
  oraclePrice,
  readGovernor,
  refusalOf,
  withBudget,
  type Instrument,
  type Network,
} from "../sdk/evm-stocks";
import { PatientProvider, isRateLimit, nodeRefused } from "./quaestor";

export const DEFAULTS = {
  // Robinhood Chain's testnet, where agents trade today; mainnet (`--network robinhood`) has the
  // factory and takes Paxos's USDG.
  network: "robinhood-testnet",
  app: "https://quaestor-app.onrender.com",
  ledger: "https://quaestor-hub.onrender.com",
};
export const MAX_SLIPPAGE_BPS = 500;
const MAX_REASON_CHARS = 500;
const CONFIRM_MS = 60_000;
/** Without a guard on-chain, the command still refuses a fill this far over Chainlink's price. */
const DEFAULT_ORACLE_MARGIN_BPS = 150;

export const REFUSALS = EVM_REFUSALS;

export class CliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type Result = Record<string, unknown>;
const refused = (code: string, detail: string): Result => ({ ok: false, refused: code, detail, meaning: REFUSALS[code] ?? "The governor refused it." });

// ------------------------------------------------------------------ arguments

export function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) throw new CliError("BAD_ARGUMENT", `unexpected argument "${token}"`);
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq < 0 ? body : body.slice(0, eq);
    if (eq >= 0) flags[name] = body.slice(eq + 1);
    else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) flags[name] = rest[++i];
    else flags[name] = "true";
  }
  return { command, flags };
}

const COMMON = ["key-file", "rpc", "network", "governor"];
const AMOUNT = ["amount", "usdg", "usdc"];
export const FLAGS: Record<string, string[]> = {
  help: [],
  keygen: ["key-file"],
  register: ["key-file", "network", "budget", "deposit", "per-trade", "epoch-cap", "epoch", "stocks", "limit"],
  whoami: ["key-file", "rpc", "network"],
  status: COMMON,
  quote: ["stock", ...AMOUNT, "budget", "slippage-bps", ...COMMON],
  buy: ["stock", ...AMOUNT, "reason", "slippage-bps", "min-out", "dry-run", ...COMMON],
  check: ["key-file", "rpc", "network"],
};
const BOOLEAN = new Set(["dry-run"]);

export function checkFlags(command: string, flags: Record<string, string>): void {
  const allowed = FLAGS[command];
  if (!allowed) throw new CliError("UNKNOWN_COMMAND", `unknown command "${command}"; run "help"`);
  for (const [name, value] of Object.entries(flags)) {
    if (!allowed.includes(name)) throw new CliError("BAD_ARGUMENT", `${command} does not take --${name}`);
    if (BOOLEAN.has(name) && value !== "true") throw new CliError("BAD_ARGUMENT", `--${name} takes no value`);
  }
}

/** A decimal amount typed by an agent, in base units of `decimals`. */
export function unitsOf(raw: string | undefined, name: string, decimals: number): bigint {
  if (raw === undefined || raw === "true") throw new CliError("MISSING_ARGUMENT", `--${name} is required`);
  const re = new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  if (!re.test(raw)) throw new CliError("BAD_ARGUMENT", `--${name} must be an amount such as 1 or 0.5, with at most ${decimals} decimals`);
  const value = ethers.parseUnits(raw, decimals);
  if (value <= 0n) throw new CliError("BAD_ARGUMENT", `--${name} must be more than zero`);
  return value;
}

/** The budget amount, under whichever name the agent used: --amount, --usdg or --usdc. */
export function budgetAmountOf(flags: Record<string, string>, n: Network): { units: bigint; name: string } {
  const given = AMOUNT.filter((k) => flags[k] !== undefined);
  if (given.length > 1) throw new CliError("BAD_ARGUMENT", `give the amount once, as --${n.budget.symbol.toLowerCase()} or --amount`);
  const name = given[0] ?? n.budget.symbol.toLowerCase();
  const names = budgetsOf(n).flatMap((b) => [b.symbol.toLowerCase(), b.symbol.toLowerCase().replace(/^t/, "")]);
  if (name !== "amount" && !names.includes(name)) {
    throw new CliError("BAD_ARGUMENT", `the budget on ${n.name} is ${budgetsOf(n).map((b) => b.symbol).join(" or ")}; use --amount or --${n.budget.symbol.toLowerCase()}`);
  }
  return { units: unitsOf(flags[name], name, n.budget.decimals), name };
}

export function slippageOf(flags: Record<string, string>): number {
  const bps = Number(flags["slippage-bps"] ?? "100");
  if (!Number.isInteger(bps) || bps < 1) throw new CliError("BAD_ARGUMENT", "--slippage-bps must be a whole number, at least 1");
  if (bps > MAX_SLIPPAGE_BPS) throw new CliError("SLIPPAGE_TOO_WIDE", `--slippage-bps may be at most ${MAX_SLIPPAGE_BPS}; a wider floor protects nothing`);
  return bps;
}

/** The reason is hashed into the trade the chain records; it must be present, short, and never the key. */
export function reasonOf(flags: Record<string, string>, key?: string): string {
  const reason = (flags.reason ?? "").trim();
  if (!reason || reason === "true") throw new CliError("MISSING_ARGUMENT", "--reason is required: it is committed with the trade");
  if (reason.length > MAX_REASON_CHARS) throw new CliError("BAD_ARGUMENT", `--reason may be at most ${MAX_REASON_CHARS} characters`);
  if (key && reason.toLowerCase().includes(key.slice(2).toLowerCase())) throw new CliError("REASON_LOOKS_SECRET", "--reason contains this agent's key; it was not sent");
  return reason;
}

export const fmt = (units: bigint, decimals: number) => ethers.formatUnits(units, decimals).replace(/\.0$/, "");

// ------------------------------------------------------------------ settings, network and key

export interface Settings {
  network: Network;
  rpcUrl: string;
  keyFile: string;
  app: string;
  ledger: string;
}

/**
 * The network: a key from the table, or a JSON file of the same shape (a new
 * deployment, or a local chain in tests) named by QUAESTOR_EVM_NETWORK_FILE.
 */
export function networkFrom(flags: Record<string, string>, env: NodeJS.ProcessEnv = process.env): Network {
  if (env.QUAESTOR_EVM_NETWORK_FILE) return JSON.parse(fs.readFileSync(env.QUAESTOR_EVM_NETWORK_FILE, "utf8")) as Network;
  const key = flags.network ?? env.QUAESTOR_EVM_NETWORK ?? DEFAULTS.network;
  const n = NETWORKS[key];
  if (!n) throw new CliError("BAD_ARGUMENT", `--network must be one of: ${Object.keys(NETWORKS).join(", ")}`);
  return n;
}

export function settingsFrom(flags: Record<string, string>, env: NodeJS.ProcessEnv = process.env): Settings {
  const network = networkFrom(flags, env);
  return {
    network,
    rpcUrl: flags.rpc ?? env.QUAESTOR_EVM_RPC_URL ?? network.rpcUrl,
    keyFile: flags["key-file"] ?? env.QUAESTOR_EVM_KEY_FILE ?? path.join(os.homedir(), ".quaestor", "evm-operator.key"),
    app: env.QUAESTOR_APP_URL ?? DEFAULTS.app,
    ledger: env.QUAESTOR_LEDGER_URL ?? DEFAULTS.ledger,
  };
}

export function keygen(keyFile: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.QUAESTOR_EVM_KEY) throw new CliError("KEY_IN_ENV", "QUAESTOR_EVM_KEY is set, and every command uses it; unset it to make a key file");
  if (fs.existsSync(keyFile)) throw new CliError("KEY_EXISTS", `${keyFile} already holds a key; it is not replaced. Use --key-file for a second agent.`);
  const wallet = ethers.Wallet.createRandom();
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, `${wallet.privateKey}\n`, { mode: 0o600, flag: "wx" });
  return wallet.address;
}

export function loadKey(keyFile: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.QUAESTOR_EVM_KEY ?? (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8") : "")).trim();
  if (!raw) throw new CliError("NO_KEY", 'no key: run "keygen" first, or set QUAESTOR_EVM_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new CliError("BAD_KEY", "the key is not a 32-byte hex private key");
  return raw;
}

/** The link the owner opens to sign the governor into being, with what the agent proposes. */
export function registerUrl(s: Settings, operator: string, flags: Record<string, string> = {}): string {
  const n = flags.budget ? budgetNetwork(s.network, flags.budget) : s.network;
  const q = new URLSearchParams({ operator });
  if (flags.budget) q.set("budget", n.budget.symbol);
  const epochs: Record<string, string> = { hour: "3600", day: "86400", week: "604800" };
  for (const [flag, param] of [["deposit", "deposit"], ["per-trade", "perTrade"], ["epoch-cap", "epochCap"]] as const) {
    if (flags[flag]) q.set(param, fmt(unitsOf(flags[flag], flag, n.budget.decimals), n.budget.decimals));
  }
  if (flags["per-trade"] && flags["epoch-cap"] && unitsOf(flags["per-trade"], "per-trade", 6) > unitsOf(flags["epoch-cap"], "epoch-cap", 6)) {
    throw new CliError("BAD_ARGUMENT", "--per-trade is larger than --epoch-cap");
  }
  if (flags.epoch) {
    if (!epochs[flags.epoch]) throw new CliError("BAD_ARGUMENT", "--epoch must be hour, day or week");
    q.set("epoch", epochs[flags.epoch]);
  }
  if (flags.stocks) {
    const symbols = flags.stocks.split(",").map((x) => x.trim()).filter(Boolean);
    for (const sym of symbols) if (!instrumentOf(n, sym)) throw new CliError("BAD_ARGUMENT", `${sym} is not a Stock Token this command knows on ${n.name}`);
    // Each as the chain spells it (tETH, not TETH): the page matches the symbols it lists.
    q.set("stocks", symbols.map((x) => instrumentOf(n, x)!.symbol).join(","));
  }
  if (flags.limit) {
    // --limit AAPL=370,NVDA=250: the most the owner is asked to pay for one share.
    const limits = flags.limit.split(",").map((pair) => {
      const [sym, price] = pair.split("=");
      if (!instrumentOf(n, sym ?? "") || !price) throw new CliError("BAD_ARGUMENT", "--limit takes SYMBOL=price pairs, such as AAPL=370");
      unitsOf(price, "limit", n.budget.decimals);
      return `${instrumentOf(n, sym)!.symbol}=${price}`;
    });
    q.set("limit", limits.join(","));
  }
  return `${s.app}/#/app/evm/${n.key}/register?${q.toString()}`;
}

/** The chain as a governor holding the named dollar sees it; a dollar the chain lacks is refused. */
export function budgetNetwork(n: Network, symbolOrAddress: string): Network {
  if (!budgetOf(n, symbolOrAddress)) throw new CliError("BAD_ARGUMENT", `--budget must be one of ${budgetsOf(n).map((b) => b.symbol).join(", ")} on ${n.name}`);
  return withBudget(n, symbolOrAddress);
}

// ------------------------------------------------------------------ context

export interface Context {
  settings: Settings;
  provider: ethers.JsonRpcProvider;
  wallet?: ethers.Wallet;
  address?: string;
  now?: () => Date;
}

export async function contextFor(flags: Record<string, string>, signing: boolean, env: NodeJS.ProcessEnv = process.env): Promise<Context> {
  const settings = settingsFrom(flags, env);
  const provider = new PatientProvider(settings.rpcUrl, settings.network.chainId);
  const chainId = BigInt(await provider.send("eth_chainId", []));
  if (chainId !== BigInt(settings.network.chainId)) {
    throw new CliError("WRONG_CHAIN", `the RPC serves chain ${chainId}, not ${settings.network.chainId} (${settings.network.name})`);
  }
  if (!signing) return { settings, provider };
  const wallet = new ethers.Wallet(loadKey(settings.keyFile, env), provider);
  return { settings, provider, wallet, address: wallet.address };
}

/** The key's address without the chain: status says whose governor it is looking at when it can. */
function addressIfKey(settings: Settings, env: NodeJS.ProcessEnv): string | undefined {
  try {
    return new ethers.Wallet(loadKey(settings.keyFile, env)).address;
  } catch {
    return undefined;
  }
}

function requireFactory(n: Network): string {
  if (!n.factory) throw new CliError("NOT_DEPLOYED", `the governor factory is not deployed on ${n.name} yet`);
  return n.factory;
}

/** Governors made for this key, checked live: anyone can name any key, and an owner can rotate one out. */
async function governorsFor(ctx: Context, operator: string): Promise<string[]> {
  const factory = new ethers.Contract(requireFactory(ctx.settings.network), FACTORY_ABI, ctx.provider);
  const listed: string[] = await factory.governorsForOperator(operator);
  const live = await Promise.all(listed.map(async (g) => ((await new ethers.Contract(g, GOVERNOR_ABI, ctx.provider).operator()) as string).toLowerCase() === operator.toLowerCase()));
  return listed.filter((_, i) => live[i]);
}

export async function governorFor(ctx: Context, operator: string, chosen?: string): Promise<string> {
  if (chosen) {
    if (!ethers.isAddress(chosen)) throw new CliError("BAD_ARGUMENT", "--governor must be an address");
    const op: string = await new ethers.Contract(chosen, GOVERNOR_ABI, ctx.provider).operator().catch(() => ethers.ZeroAddress);
    if (op.toLowerCase() !== operator.toLowerCase()) throw new CliError("NotOperator", `governor ${chosen} does not name this key as operator`);
    return ethers.getAddress(chosen);
  }
  const mine = await governorsFor(ctx, operator);
  if (!mine.length) throw new CliError("NO_GOVERNOR", `no governor names this key yet; send the owner the register link: ${registerUrl(ctx.settings, operator)}`);
  if (mine.length > 1) throw new CliError("SEVERAL_GOVERNORS", `${mine.length} governors name this key; pass --governor with one of: ${mine.join(", ")}`);
  return mine[0];
}

/** The dollar this key's governor holds, when there is exactly one and the chain lists it; else nothing. */
async function governorBudget(ctx: Context, flags: Record<string, string>, operator?: string): Promise<string | undefined> {
  if (!operator || !ctx.settings.network.otherBudgets?.length) return undefined;
  try {
    const governor = await governorFor(ctx, operator, flags.governor);
    const token: string = await new ethers.Contract(governor, GOVERNOR_ABI, ctx.provider).budgetToken();
    return budgetOf(ctx.settings.network, token) ? token : undefined;
  } catch {
    return undefined;
  }
}

function instrumentFlag(n: Network, flags: Record<string, string>): Instrument {
  const sym = flags.stock;
  if (!sym || sym === "true") throw new CliError("MISSING_ARGUMENT", `--stock is required: one of ${n.instruments.map((i) => i.symbol).join(", ")}`);
  const inst = instrumentOf(n, sym);
  if (!inst) throw new CliError("BAD_ARGUMENT", `${sym} is not a Stock Token this command knows on ${n.name}: ${n.instruments.map((i) => i.symbol).join(", ")}`);
  return inst;
}

/** A max fee 10% over the latest base fee, plus the node's tip: what the next blocks will charge. */
async function chargedChainFees(provider: ethers.Provider): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
  const [block, fee] = await Promise.all([provider.getBlock("latest"), provider.getFeeData()]);
  if (!block?.baseFeePerGas || fee.maxPriorityFeePerGas === null) return {};
  return { maxPriorityFeePerGas: fee.maxPriorityFeePerGas, maxFeePerGas: (block.baseFeePerGas * 11n) / 10n + fee.maxPriorityFeePerGas };
}

// ------------------------------------------------------------------ pending buys

interface PendingBuy {
  hash: string;
  raw: string;
  nonce: number;
  network: string;
  governor: string;
  record: string;
  decisionHash: string;
  shareDecimals: number;
  sentAt: string;
}

const pendingPath = (s: Settings) => path.join(path.dirname(s.keyFile), `evm-${s.network.key}-pending.json`);
const readPending = (s: Settings): PendingBuy | null => (fs.existsSync(pendingPath(s)) ? (JSON.parse(fs.readFileSync(pendingPath(s), "utf8")) as PendingBuy) : null);

function writePending(s: Settings, p: PendingBuy): void {
  fs.mkdirSync(path.dirname(s.keyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pendingPath(s), JSON.stringify(p, null, 2), { mode: 0o600 });
}

const clearPending = (s: Settings) => fs.rmSync(pendingPath(s), { force: true });

export function refuseIfPending(s: Settings): Result | null {
  const p = readPending(s);
  if (!p) return null;
  return { ok: false, error: "PENDING_BUY", tx: explorerTx(s.network, p.hash), message: `an earlier buy (${p.hash}) has not been settled. Run "check" before any new buy; do not repeat it.` };
}

/** Why a mined buy reverted: the same call replayed against the state just before its block. */
async function revertOf(ctx: Context, hash: string, receipt: ethers.TransactionReceipt, shareDecimals: number): Promise<Result> {
  const tx = await ctx.provider.getTransaction(hash);
  try {
    await ctx.provider.call({ to: tx!.to, from: tx!.from, data: tx!.data, blockTag: receipt.blockNumber - 1 });
  } catch (err) {
    const r = refusalOf(err, ctx.settings.network.budget.decimals, shareDecimals);
    if (r) return refused(r.code, r.detail);
  }
  return { ok: false, refused: "Reverted", detail: `the transaction reverted in block ${receipt.blockNumber}; the reason could not be recovered`, meaning: "Nothing was spent except gas." };
}

/** Put the reason behind a settled buy where the app can re-hash it against the chain. */
async function publishRecord(s: Settings, text: string, decisionHash: string): Promise<string | undefined> {
  if (ethers.keccak256(ethers.toUtf8Bytes(text)) !== decisionHash) return "not published: the record does not hash to the committed decision";
  try {
    const res = await fetch(`${s.ledger}/decisions`, { method: "POST", headers: { "content-type": "text/plain" }, body: text, signal: AbortSignal.timeout(20_000) });
    return res.ok ? undefined : `the ledger answered ${res.status}`;
  } catch (err) {
    return `the ledger did not answer (${(err as Error).message})`;
  }
}

// ------------------------------------------------------------------ commands

export async function whoami(ctx: Context): Promise<Result> {
  const n = ctx.settings.network;
  const gas = await ctx.provider.getBalance(ctx.address!);
  const governors = n.factory ? await governorsFor(ctx, ctx.address!) : [];
  return {
    ok: true,
    network: n.name,
    operator: ctx.address,
    gas: `${ethers.formatEther(gas)} ${n.gasSymbol}`,
    governors,
    registerUrl: registerUrl(ctx.settings, ctx.address!),
    note: gas === 0n ? `This key has no ${n.gasSymbol} for gas. The owner's register link sends it ${n.agentGas} ${n.gasSymbol} with the governor.` : undefined,
  };
}

export async function status(ctx: Context, flags: Record<string, string>, operator?: string): Promise<Result> {
  const governor = operator ? await governorFor(ctx, operator, flags.governor) : flags.governor;
  if (!governor) throw new CliError("MISSING_ARGUMENT", "--governor is required without a key");
  const g = await readGovernor(ctx.provider, ctx.settings.network, governor, Math.floor((ctx.now?.() ?? new Date()).getTime() / 1000));
  const n = budgetOf(ctx.settings.network, g.budgetToken) ? withBudget(ctx.settings.network, g.budgetToken) : ctx.settings.network;
  const b = (v: bigint) => `${fmt(v, n.budget.decimals)} ${n.budget.symbol}`;
  const holdings = await Promise.all(g.instruments.filter((i) => i.allowed || i.held > 0n).map(async (i) => {
    const inst = instrumentOf(ctx.settings.network, i.address)!;
    const oracle = inst.feed ? await oraclePrice(ctx.provider, inst.feed, n.budget.decimals).catch(() => null) : null;
    return {
      stock: i.symbol,
      allowed: i.allowed,
      held: fmt(i.held, inst.decimals),
      limitPrice: i.limitPrice ? b(i.limitPrice) : "none",
      chainlink: oracle ? { price: b(oracle.price), updatedAt: new Date(oracle.updatedAt * 1000).toISOString() } : undefined,
      guard: i.guard ? `fills at most ${i.guard.maxDeviationBps / 100}% over Chainlink, price at most ${Math.round(i.guard.maxStaleness / 3600)}h old` : "none",
    };
  }));
  const gas = operator ? await ctx.provider.getBalance(operator) : null;
  return {
    ok: true,
    network: n.name,
    governor: g.address,
    budgetToken: `${n.budget.symbol} ${g.budgetToken}`,
    explorer: explorerAddress(n, g.address),
    owner: g.owner,
    operator: g.operator,
    thisKeyIsOperator: operator ? operator.toLowerCase() === g.operator.toLowerCase() : undefined,
    suspended: g.suspended,
    budget: b(g.budget),
    perTradeCap: b(g.perTradeCap),
    epochCap: b(g.epochCap),
    spentThisEpoch: b(g.spentThisEpoch),
    canSpendNow: b(g.remaining),
    epochEndsAt: new Date(g.epochEndsAt * 1000).toISOString(),
    venues: g.venues.filter((v) => v.allowed).map((v) => v.label),
    stocks: holdings,
    gas: gas === null ? undefined : `${ethers.formatEther(gas)} ${n.gasSymbol}`,
    page: `${ctx.settings.app}/#/app/evm/${n.key}/agents/${g.address}`,
  };
}

interface Priced {
  inst: Instrument;
  amountIn: bigint;
  quote: Awaited<ReturnType<typeof bestQuote>>;
  price: bigint;
  oracle: Awaited<ReturnType<typeof oraclePrice>> | null;
  premiumBps: number | null;
}

async function priceOf(ctx: Context, inst: Instrument, amountIn: bigint): Promise<Priced> {
  const n = ctx.settings.network;
  const quote = await bestQuote(ctx.provider, n, inst, amountIn);
  const price = fillPrice(amountIn, quote.amountOut, inst.decimals);
  const oracle = inst.feed ? await oraclePrice(ctx.provider, inst.feed, n.budget.decimals).catch(() => null) : null;
  const premiumBps = oracle && oracle.price > 0n ? Number(((price - oracle.price) * 10_000n) / oracle.price) : null;
  return { inst, amountIn, quote, price, oracle, premiumBps };
}

export async function quote(ctx: Context, inst: Instrument, amountIn: bigint, slippageBps: number): Promise<Result> {
  const n = ctx.settings.network;
  const p = await priceOf(ctx, inst, amountIn);
  const b = (v: bigint) => `${fmt(v, n.budget.decimals)} ${n.budget.symbol}`;
  return {
    ok: true,
    network: n.name,
    stock: inst.symbol,
    spend: b(amountIn),
    receive: fmt(p.quote.amountOut, inst.decimals),
    floor: fmt((p.quote.amountOut * BigInt(10_000 - slippageBps)) / 10_000n, inst.decimals),
    pricePerShare: b(p.price),
    venue: p.quote.label,
    chainlink: p.oracle ? { price: b(p.oracle.price), updatedAt: new Date(p.oracle.updatedAt * 1000).toISOString(), premiumBps: p.premiumBps } : "no feed",
    tiers: p.quote.tiers?.map((t) => ({ feePct: t.fee / 10_000, receive: t.amountOut === null ? null : fmt(t.amountOut, inst.decimals) })),
  };
}

export async function buy(ctx: Context, flags: Record<string, string>, inst: Instrument, amountIn: bigint, reason: string, slippageBps: number, dryRun: boolean): Promise<Result> {
  const governor = await governorFor(ctx, ctx.address!, flags.governor);
  const g = await readGovernor(ctx.provider, ctx.settings.network, governor);
  // Everything from here reads the governor's own dollar: its pools, its units.
  if (!budgetOf(ctx.settings.network, g.budgetToken)) return refused("UnknownBudget", `this governor holds ${g.budgetToken}, which this command does not know on ${ctx.settings.network.name}`);
  ctx = { ...ctx, settings: { ...ctx.settings, network: withBudget(ctx.settings.network, g.budgetToken) } };
  const n = ctx.settings.network;
  const s = ctx.settings;
  const b = (v: bigint) => `${fmt(v, n.budget.decimals)} ${n.budget.symbol}`;
  if (!instrumentOf(n, inst.address)) return refused("NoPool", `${inst.symbol} has no pool against ${n.budget.symbol} on ${n.name}; this governor can buy ${n.instruments.map((i) => i.symbol).join(", ") || "nothing yet"}`);

  // Everything the governor would refuse, refused here first, before a signature or a gas fee.
  if (g.suspended) return refused("Suspended", "the owner suspended this governor");
  const approved = g.instruments.find((i) => i.address.toLowerCase() === inst.address.toLowerCase());
  if (!approved?.allowed) return refused("InstrumentNotAllowed", `${inst.symbol} is not approved on this governor`);
  if (amountIn > g.perTradeCap) return refused("PerTradeCapExceeded", `${b(amountIn)} is over the per-trade cap of ${b(g.perTradeCap)}`);
  if (g.spentThisEpoch + amountIn > g.epochCap) return refused("EpochCapExceeded", `${b(g.spentThisEpoch)} spent of ${b(g.epochCap)} this epoch`);
  if (amountIn > g.budget) return refused("InsufficientBudget", `the governor holds ${b(g.budget)}`);

  const p = await priceOf(ctx, inst, amountIn);
  if (!g.venues.find((v) => v.address.toLowerCase() === p.quote.target.toLowerCase())?.allowed) {
    return refused("VenueNotAllowed", `${p.quote.venue.label} is not approved on this governor`);
  }
  if (approved.limitPrice && p.price > approved.limitPrice) {
    return refused("PriceGate", `the best fill is ${b(p.price)} a share, over the owner's limit of ${b(approved.limitPrice)}`);
  }
  if (p.oracle && p.premiumBps !== null) {
    const margin = approved.guard?.maxDeviationBps ?? DEFAULT_ORACLE_MARGIN_BPS;
    if (p.premiumBps > margin) return refused("PriceGate", `the best fill is ${b(p.price)} a share, ${p.premiumBps} bps over Chainlink's ${b(p.oracle.price)}; the most allowed is ${margin} bps`);
    const age = Math.floor(Date.now() / 1000) - p.oracle.updatedAt;
    if (approved.guard && age > approved.guard.maxStaleness) return refused("OracleStale", `Chainlink's price is ${Math.round(age / 3600)}h old; the owner allows ${Math.round(approved.guard.maxStaleness / 3600)}h`);
  }

  const minOut = flags["min-out"] ? unitsOf(flags["min-out"], "min-out", inst.decimals) : (p.quote.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minOut === 0n) return refused("InvalidMinimumOutput", "the floor rounds to zero");
  const intentId = ethers.hexlify(randomBytes(32));
  const { text, decisionHash } = commitDecision({
    kind: "quaestor-stock-buy",
    network: n.key,
    chainId: n.chainId,
    governor,
    budget: n.budget.symbol,
    intentId,
    stock: inst.symbol,
    token: inst.address,
    spend: amountIn.toString(),
    minOut: minOut.toString(),
    venue: p.quote.label,
    fee: p.quote.fee,
    quotedOut: p.quote.amountOut.toString(),
    chainlink: p.oracle ? { price: p.oracle.price.toString(), updatedAt: p.oracle.updatedAt } : null,
    reason,
    at: (ctx.now?.() ?? new Date()).toISOString(),
  });
  const trade = {
    intentId,
    venue: p.quote.target,
    tokenOut: inst.address,
    amountIn,
    minOut,
    decisionHash,
    swapData: p.quote.swapData(governor, minOut),
  };
  const contract = new ethers.Contract(governor, GOVERNOR_ABI, ctx.wallet!);
  const summary = { stock: inst.symbol, spend: b(amountIn), floor: fmt(minOut, inst.decimals), quoted: fmt(p.quote.amountOut, inst.decimals), pricePerShare: b(p.price), chainlinkPremiumBps: p.premiumBps };

  // Simulated first: the chain's own verdict, free.
  let gasLimit: bigint;
  try {
    gasLimit = await contract.executeTrade.estimateGas(trade);
  } catch (err) {
    const r = refusalOf(err, n.budget.decimals, inst.decimals);
    if (r) return { ...refused(r.code, r.detail), ...summary };
    throw err;
  }
  if (dryRun) return { ok: true, dryRun: true, wouldSend: true, governor, ...summary };

  // Monad charges the limit itself, so it is kept close to what the trade uses.
  gasLimit = (gasLimit * (n.gasLimitIsCharged ? 115n : 130n)) / 100n;
  const request = await contract.executeTrade.populateTransaction(trade);
  // The node wants gasLimit x maxFee in the key before it takes the buy. The default max fee
  // is twice the base fee; where the limit itself is charged (Monad), a key funded for a few
  // trades would be refused for want of gas it will never pay, so the cap sits just over it.
  const fees = n.gasLimitIsCharged ? await chargedChainFees(ctx.provider) : {};
  const populated = await ctx.wallet!.populateTransaction({ ...request, gasLimit, ...fees });
  const upfront = BigInt(populated.gasLimit ?? 0n) * BigInt(populated.maxFeePerGas ?? populated.gasPrice ?? 0n);
  const gas = await ctx.provider.getBalance(ctx.address!);
  if (gas < upfront) return refused("NoGas", `this key holds ${ethers.formatEther(gas)} ${n.gasSymbol}; the buy needs up to ${ethers.formatEther(upfront)}`);
  const raw = await ctx.wallet!.signTransaction(populated);
  const hash = ethers.keccak256(raw);
  writePending(s, { hash, raw, nonce: Number(populated.nonce), network: n.key, governor, record: text, decisionHash, shareDecimals: inst.decimals, sentAt: new Date().toISOString() });
  try {
    await ctx.provider.broadcastTransaction(raw);
  } catch (err) {
    const known = await ctx.provider.getTransaction(hash).catch(() => null);
    const refusedBy = nodeRefused(err);
    if (!known && refusedBy) {
      clearPending(s);
      return { ok: false, error: "NOT_SENT", message: `the node refused it (${refusedBy.slice(0, 160)}); nothing was sent` };
    }
    if (!known) return unconfirmed(n, hash, summary);
  }
  return finish(ctx, hash, summary);
}

async function finish(ctx: Context, hash: string, summary: Result, waitMs = CONFIRM_MS): Promise<Result> {
  const s = ctx.settings;
  const n = s.network;
  const pending = readPending(s);
  const receipt = await ctx.provider.waitForTransaction(hash, 1, waitMs).catch(() => null);
  if (!receipt) return unconfirmed(n, hash, summary);
  clearPending(s);
  if (receipt.status !== 1) return { ...(await revertOf(ctx, hash, receipt, pending?.shareDecimals ?? 18)), tx: explorerTx(n, hash), ...summary };
  const iface = new ethers.Interface(GOVERNOR_ABI);
  const event = receipt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "TradeExecuted");
  const skipped = pending ? await publishRecord(s, pending.record, pending.decisionHash) : "no record was kept";
  const decimals = pending?.shareDecimals ?? 18;
  return {
    ok: true,
    bought: true,
    ...summary,
    spent: event ? `${fmt(event.args.spent, n.budget.decimals)} ${n.budget.symbol}` : undefined,
    received: event ? fmt(event.args.received, decimals) : undefined,
    tx: explorerTx(n, hash),
    tradePage: pending ? `${s.app}/#/app/evm/${n.key}/trades/${hash}` : undefined,
    recordSkipped: skipped,
  };
}

function unconfirmed(n: Network, hash: string, summary: Result = {}): Result {
  return {
    ok: false,
    error: "UNCONFIRMED",
    tx: explorerTx(n, hash),
    message: 'The buy was sent and its outcome is not known yet. Do NOT send it again. Run "check" in a minute: it settles this one before any other buy is sent.',
    ...summary,
  };
}

/** Settle an interrupted buy; resend the same signed bytes if the node lost it (it cannot trade twice). */
export async function check(ctx: Context): Promise<Result> {
  const s = ctx.settings;
  const pending = readPending(s);
  if (!pending) return { ok: true, pending: false, message: "No unsettled buy. A new one may be sent." };
  const tx = explorerTx(s.network, pending.hash);
  if (await ctx.provider.getTransactionReceipt(pending.hash)) return finish(ctx, pending.hash, {}, 1_000);
  if (await ctx.provider.getTransaction(pending.hash)) return { ok: false, error: "UNCONFIRMED", pending: true, tx, message: "Still waiting to be mined. Run check again in a minute; do not send it again." };
  const used = await ctx.provider.getTransactionCount(ctx.address!, "latest");
  if (used > pending.nonce) {
    clearPending(s);
    return { ok: true, pending: false, dropped: true, tx, message: "This buy was never mined and its nonce has been used since, so it never will be. Nothing was spent." };
  }
  try {
    await ctx.provider.broadcastTransaction(pending.raw);
  } catch (err) {
    const refusedBy = nodeRefused(err);
    if (refusedBy && !(await ctx.provider.getTransaction(pending.hash).catch(() => null))) {
      clearPending(s);
      return { ok: false, error: "NOT_SENT", pending: false, tx, message: `This buy never reached the chain and the node refuses it (${refusedBy.slice(0, 160)}). Nothing was spent.` };
    }
  }
  return { ok: false, error: "UNCONFIRMED", pending: true, rebroadcast: true, tx, message: "The node had lost it, so the same signed buy was sent again; it cannot trade twice. Run check again in a minute." };
}

// ------------------------------------------------------------------ entry

const HELP = `quaestor-evm: buy tokenized stocks under a Quaestor governor on an EVM chain

  keygen                                     make this agent's key (never printed)
  register [--budget USDG] [--deposit 20] [--per-trade 5] [--epoch-cap 20] [--epoch day]
           [--stocks AAPL,NVDA] [--limit AAPL=370]
                                             the link the owner opens and signs once
  whoami                                     this key, its gas, the governors naming it
  status [--governor <address>]              caps, spend, budget, holdings, Chainlink prices
  quote --stock AAPL --usdg 5 [--budget USDG] Uniswap's best fill against Chainlink's price, in the
                                             governor's dollar (or --budget's, or the chain's default)
  buy --stock AAPL --usdg 5 --reason "<why>" [--slippage-bps 100] [--min-out <shares>] [--dry-run]
  check                                      settle a buy that was sent but not confirmed

  --network <key>     ${Object.keys(NETWORKS).join(" | ")} (default ${DEFAULTS.network}, or QUAESTOR_EVM_NETWORK)
  --key-file <path>   the agent's key (default ~/.quaestor/evm-operator.key)
  --rpc <url>         the chain's RPC (or QUAESTOR_EVM_RPC_URL)`;

export async function run(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; out: Result | string }> {
  let shareDecimals = 18;
  let budgetDecimals = 6;
  try {
    const { command, flags } = parseArgs(argv);
    if (command === "--help") return { code: 0, out: HELP };
    checkFlags(command, flags);
    switch (command) {
      case "help":
        return { code: 0, out: HELP };
      case "keygen": {
        const s = settingsFrom(flags, env);
        const operator = keygen(s.keyFile, env);
        return { code: 0, out: { ok: true, operator, keyFile: s.keyFile, registerUrl: registerUrl(s, operator), next: "Agree a deposit, caps, stocks and limit prices with the user, then run register for the link the owner signs. Never share the key file." } };
      }
      case "register": {
        const s = settingsFrom(flags, env);
        const operator = new ethers.Wallet(loadKey(s.keyFile, env)).address;
        return { code: 0, out: { ok: true, network: s.network.name, operator, registerUrl: registerUrl(s, operator, flags), next: "Send the user this link. They open it, check every number, and sign once in their own wallet." } };
      }
      case "whoami":
        return { code: 0, out: await whoami(await contextFor(flags, true, env)) };
      case "status": {
        const ctx = await contextFor(flags, false, env);
        return { code: 0, out: await status(ctx, flags, addressIfKey(ctx.settings, env)) };
      }
      case "quote": {
        let ctx = await contextFor(flags, false, env);
        const inst = instrumentFlag(ctx.settings.network, flags);
        const units = budgetAmountOf(flags, ctx.settings.network).units;
        const budget = flags.budget ?? (await governorBudget(ctx, flags, addressIfKey(ctx.settings, env)));
        if (budget) ctx = { ...ctx, settings: { ...ctx.settings, network: budgetNetwork(ctx.settings.network, budget) } };
        if (!instrumentOf(ctx.settings.network, inst.address)) throw new CliError("BAD_ARGUMENT", `${inst.symbol} has no pool against ${ctx.settings.network.budget.symbol} on ${ctx.settings.network.name}`);
        return { code: 0, out: await quote(ctx, inst, units, slippageOf(flags)) };
      }
      case "check":
        return exitFor(await check(await contextFor(flags, true, env)));
      case "buy": {
        const s = settingsFrom(flags, env);
        const inst = instrumentFlag(s.network, flags);
        shareDecimals = inst.decimals;
        budgetDecimals = s.network.budget.decimals;
        const { units } = budgetAmountOf(flags, s.network);
        const slippage = slippageOf(flags);
        reasonOf(flags);
        const ctx = await contextFor(flags, true, env);
        const reason = reasonOf(flags, ctx.wallet!.privateKey);
        const blocked = refuseIfPending(ctx.settings);
        if (blocked) return { code: 1, out: blocked };
        return exitFor(await buy(ctx, flags, inst, units, reason, slippage, flags["dry-run"] === "true"));
      }
      default:
        throw new CliError("UNKNOWN_COMMAND", `unknown command "${command}"; run "help"`);
    }
  } catch (err) {
    if (err instanceof CliError) {
      if (REFUSALS[err.code]) return { code: 2, out: refused(err.code, err.message) };
      return { code: 1, out: { ok: false, error: err.code, message: err.message } };
    }
    const r = refusalOf(err, budgetDecimals, shareDecimals);
    if (r) return { code: 2, out: refused(r.code, r.detail) };
    const e = err as { info?: { error?: { code?: number; message?: string } }; shortMessage?: string; message?: string };
    const said = e.info?.error;
    const message = said ? `the endpoint said ${said.code ?? ""} ${said.message ?? ""}`.trim() : (e.shortMessage ?? e.message ?? String(err));
    return { code: 1, out: { ok: false, error: isRateLimit(said) ? "RATE_LIMITED" : "FAILED", message: message.slice(0, 300) } };
  }
}

function exitFor(out: Result): { code: number; out: Result } {
  if (out.ok) return { code: 0, out };
  return { code: out.refused ? 2 : 1, out };
}

// Run when executed directly, not when imported by a test.
const invoked = process.argv[1] ?? "";
if (/quaestor-evm\.(ts|mjs|js)$/.test(invoked)) {
  void run(process.argv.slice(2)).then(({ code, out }) => {
    process.stdout.write(typeof out === "string" ? `${out}\n` : `${JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
    process.exitCode = code;
  });
}
