/**
 * quaestor: the one command an agent runs to trade on Base under a governor.
 *
 *   node quaestor.mjs keygen                      make this agent's operator key
 *   node quaestor.mjs agents                      which agents this key operates
 *   node quaestor.mjs status --agent 7            caps, spend, treasury, gas
 *   node quaestor.mjs quote --eth 0.0001          what Uniswap gives for it now
 *   node quaestor.mjs buy --agent 7 --eth 0.0001 --reason "..."
 *   node quaestor.mjs pay --agent 7 --category data --to 0x… --eth 0.00001 --reason "..."
 *   node quaestor.mjs check                       settle what an interrupted spend did
 *
 * The agent holds its own operator key, in a file only it reads. That key can
 * trade through the governor, inside the caps its owner set, to venues and
 * tokens its owner allowed, with whatever it buys landing in the owner's
 * wallet; and it can pay for data or inference, to any address, up to those
 * two categories' caps. The owner registers the agent from their own wallet in
 * the app, and nothing here ever sees the owner's key.
 *
 * Every command prints one JSON object. A refusal is not an error: it exits 2
 * and says in plain words what was refused. A spend is signed here and its
 * hash recorded before it is sent, so a connection that drops mid-spend never
 * leaves the agent unsure whether to try again: it runs `check`, and until
 * `check` has settled it, no other spend is sent.
 */
import { ethers } from "ethers";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  Category,
  QUAESTOR_LOG_ABI,
  QUAESTOR_V2_ABI,
  credentialIn,
  metaHashOf,
  type DecisionMeta,
} from "../sdk/evm";
import { NoPoolError, UNISWAP_BASE, bestQuote, exactInputSingleData } from "../sdk/uniswap";

/** Base mainnet, as deployed. Every address can be overridden for a fork or another deployment. */
export const BASE = {
  chainId: 8453,
  rpcUrl: "https://mainnet.base.org",
  governor: "0x2e91d035D622d2ECa36B7836CBcf9651711B2D10",
  log: "0x1219c62A56771CdCE7bb1f6e6a5ac05701DDF961",
  app: "https://quaestor-app.onrender.com",
  ledger: "https://quaestor-hub.onrender.com",
  explorerTx: "https://basescan.org/tx/",
};

/**
 * The widest slippage `buy` accepts. Past this, a floor stops protecting
 * anything: an agent talked into "just raise the slippage" would be handing the
 * difference to whoever sits in front of it in the block.
 */
export const MAX_SLIPPAGE_BPS = 500;
export const DEFAULT_SLIPPAGE_BPS = 100;
const MAX_REASON_CHARS = 500;
/** How long a sent spend is waited for before it is reported as unconfirmed. */
const CONFIRM_MS = 90_000;

/** What each refusal means. Facts only: what to do next is the skill's to say, never "try with less". */
export const REFUSALS: Record<string, string> = {
  PerCallCapExceeded: "Larger than the owner's per-action cap for this purpose. Only the owner can raise it.",
  EpochCapExceeded: "This period's budget for this purpose is used up. It resets at the next epoch; only the owner can raise it.",
  InsufficientTreasury: "The treasury holds less than this. Only the owner can deposit.",
  VenueNotAllowed: "The owner has not allowed this venue. Only the owner can allow it.",
  InstrumentNotAllowed: "The owner has not allowed this token. Only the owner can allow it.",
  AgentIsSuspended: "The owner or the guardian has suspended this agent.",
  NotOperator: "This key is not the operator of that agent.",
  UnknownAgent: "No agent has this id on this governor.",
  ZeroAmount: "An amount or the minimum output came out as zero.",
  MinimumOutputNotMet: "The venue paid out, but less than the floor reached the owner: the route sent the tokens elsewhere. The whole trade was undone.",
  RouteOverspent: "The venue took more than the amount authorised. The whole trade was undone.",
  VenueCallFailed: "The venue refused the trade; its own reason is in detail. \"Too little received\" means the price moved past the floor.",
  PriceMoved: "The price moved since the floor was approved: the fresh floor is below it. Nothing was sent.",
};

export class CliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

// ------------------------------------------------------------------ arguments

export interface Args {
  command: string;
  flags: Record<string, string>;
}

/** `buy --agent 7 --eth=0.001` → { command: "buy", flags: { agent: "7", eth: "0.001" } }. */
export function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) throw new CliError("BAD_ARGUMENT", `unexpected argument "${token}"`);
    const body = token.slice(2);
    // Split on the first "=" only: a reason or a URL may hold more.
    const eq = body.indexOf("=");
    const name = eq < 0 ? body : body.slice(0, eq);
    if (eq >= 0) flags[name] = body.slice(eq + 1);
    else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) flags[name] = rest[++i];
    else flags[name] = "true";
  }
  return { command, flags };
}

/**
 * The flags each command takes. Anything else is refused rather than ignored:
 * a misspelt --dryrun that was silently dropped would send a real trade.
 */
const COMMON = ["key-file", "rpc"];
export const FLAGS: Record<string, string[]> = {
  keygen: ["key-file"],
  whoami: COMMON,
  agents: COMMON,
  status: ["agent", "token", ...COMMON],
  quote: ["eth", "token", "rpc"],
  buy: ["agent", "eth", "reason", "slippage-bps", "min-out", "token", "dry-run", ...COMMON],
  pay: ["agent", "category", "to", "eth", "reason", "dry-run", ...COMMON],
  check: COMMON,
  help: [],
};
const BOOLEAN_FLAGS = new Set(["dry-run"]);

export function checkFlags(command: string, flags: Record<string, string>): void {
  const allowed = FLAGS[command];
  if (!allowed) throw new CliError("UNKNOWN_COMMAND", `unknown command "${command}"; run "help"`);
  for (const [name, value] of Object.entries(flags)) {
    if (!allowed.includes(name)) throw new CliError("BAD_ARGUMENT", `${command} does not take --${name}`);
    if (BOOLEAN_FLAGS.has(name) && value !== "true") throw new CliError("BAD_ARGUMENT", `--${name} takes no value`);
  }
}

function required(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (value === undefined || value === "true") throw new CliError("MISSING_ARGUMENT", `--${name} is required`);
  return value;
}

export function agentIdOf(flags: Record<string, string>): bigint {
  const raw = required(flags, "agent").replace(/^#/, "");
  if (!/^\d+$/.test(raw) || raw === "0") throw new CliError("BAD_ARGUMENT", "--agent must be an agent id such as 7");
  return BigInt(raw);
}

export function ethOf(flags: Record<string, string>, name = "eth"): bigint {
  const raw = required(flags, name);
  let wei: bigint;
  try {
    wei = ethers.parseEther(raw);
  } catch {
    throw new CliError("BAD_ARGUMENT", `--${name} must be an amount of ETH such as 0.0001`);
  }
  if (wei <= 0n) throw new CliError("BAD_ARGUMENT", `--${name} must be more than zero`);
  return wei;
}

export function slippageOf(flags: Record<string, string>): number {
  const raw = flags["slippage-bps"] ?? String(DEFAULT_SLIPPAGE_BPS);
  const bps = Number(raw);
  if (!Number.isInteger(bps) || bps < 1) throw new CliError("BAD_ARGUMENT", "--slippage-bps must be a whole number of basis points, at least 1");
  if (bps > MAX_SLIPPAGE_BPS) {
    throw new CliError("SLIPPAGE_TOO_WIDE", `--slippage-bps may be at most ${MAX_SLIPPAGE_BPS}; a wider floor protects nothing`);
  }
  return bps;
}

/**
 * The reason goes on chain for good, so it is checked before anything is sent:
 * present, short, carrying nothing that looks like a credential, and never the
 * operator key this process holds, in any case, with or without its 0x. The
 * general guard cannot tell a key from a transaction hash; this check does not
 * need to, because it knows the one key it is protecting.
 */
export function reasonOf(flags: Record<string, string>, key?: string): string {
  const reason = required(flags, "reason").trim();
  if (!reason) throw new CliError("MISSING_ARGUMENT", "--reason is required: it is published on chain with the spend");
  if (reason.length > MAX_REASON_CHARS) throw new CliError("BAD_ARGUMENT", `--reason may be at most ${MAX_REASON_CHARS} characters`);
  const leaked = credentialIn(reason);
  if (leaked) throw new CliError("REASON_LOOKS_SECRET", `--reason looks like it contains ${leaked}; it would be published on chain, so it was not sent`);
  if (key && reason.toLowerCase().includes(key.slice(2).toLowerCase())) {
    throw new CliError("REASON_LOOKS_SECRET", "--reason contains this agent's operator key; it would be published on chain, so it was not sent");
  }
  return reason;
}

/** The owner's floor: the quote less the slippage, never zero. */
export function minOutOf(quoted: bigint, slippageBps: number): bigint {
  const minOut = (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minOut <= 0n) throw new CliError("QUOTE_TOO_SMALL", "the quote is too small to set a minimum output above zero; the amount is too small");
  return minOut;
}

/** A payee that would strand the money or hand it back to the agent's own key. */
export function checkPayee(payee: string, settings: Settings, operator: string): string {
  if (!ethers.isAddress(payee)) throw new CliError("BAD_ARGUMENT", "--to must be an address");
  const to = ethers.getAddress(payee);
  const bad: Record<string, string> = {
    [ethers.getAddress(settings.governor)]: "the governor itself, which would strand the ETH there",
    [ethers.getAddress(settings.log)]: "the decision log, which cannot hold ETH",
    [ethers.getAddress(operator)]: "this agent's own operator key",
    [ethers.ZeroAddress]: "the zero address",
  };
  if (bad[to]) throw new CliError("BAD_PAYEE", `--to is ${bad[to]}`);
  return to;
}

// ------------------------------------------------------------------ settings

export interface Settings {
  rpcUrl: string;
  governor: string;
  log: string;
  app: string;
  ledger: string;
  keyFile: string;
  token: string;
  chainId: number;
}

export function settingsFrom(flags: Record<string, string>, env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    rpcUrl: flags.rpc ?? env.QUAESTOR_RPC_URL ?? BASE.rpcUrl,
    governor: env.QUAESTOR_GOVERNOR ?? BASE.governor,
    log: env.QUAESTOR_LOG ?? BASE.log,
    app: env.QUAESTOR_APP_URL ?? BASE.app,
    ledger: env.QUAESTOR_LEDGER_URL ?? BASE.ledger,
    keyFile: flags["key-file"] ?? env.QUAESTOR_KEY_FILE ?? path.join(os.homedir(), ".quaestor", "operator.key"),
    token: flags.token ?? UNISWAP_BASE.usdc,
    chainId: Number(env.QUAESTOR_CHAIN_ID ?? BASE.chainId),
  };
}

/** Where an owner registers this agent, with its operator already filled in. */
export function registerUrl(app: string, operator: string): string {
  return `${app}/#/app/agents/new?chain=base&operator=${operator}`;
}

// ------------------------------------------------------------------ the key

/**
 * A new operator key, written where only this user can read it. It refuses to
 * overwrite: replacing an operator key the owner already registered would
 * strand the agent until the owner registers another. It also refuses while a
 * key is set in the environment, because every other command would use that
 * one, and the link it prints would name a key the agent never signs with.
 */
export function keygen(keyFile: string, env: NodeJS.ProcessEnv = process.env): { address: string; keyFile: string } {
  if (env.QUAESTOR_OPERATOR_KEY) {
    throw new CliError("KEY_IN_ENV", "QUAESTOR_OPERATOR_KEY is set, and every command uses it; unset it to make a key file, or use that key");
  }
  if (fs.existsSync(keyFile)) {
    throw new CliError("KEY_EXISTS", `${keyFile} already holds an operator key; it is not replaced. Use --key-file for a second agent.`);
  }
  const wallet = ethers.Wallet.createRandom();
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, `${wallet.privateKey}\n`, { mode: 0o600, flag: "wx" });
  return { address: wallet.address, keyFile };
}

/** The operator key: from QUAESTOR_OPERATOR_KEY if set, else the key file. Never printed. */
export function loadKey(keyFile: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.QUAESTOR_OPERATOR_KEY ?? (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8") : "");
  const key = raw.trim();
  if (!key) throw new CliError("NO_KEY", `no operator key: run "keygen" first, or set QUAESTOR_OPERATOR_KEY`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new CliError("BAD_KEY", "the operator key is not a 32-byte hex private key");
  return key;
}

// ------------------------------------------------------------------ refusals

const REFUSAL_ERRORS = new ethers.Interface(
  [...QUAESTOR_V2_ABI, ...QUAESTOR_LOG_ABI].filter((line) => line.startsWith("error ")),
);
/** Refusals whose amounts are ETH out of the treasury; MinimumOutputNotMet's are the token's. */
const ETH_REFUSALS = new Set(["PerCallCapExceeded", "EpochCapExceeded", "InsufficientTreasury", "RouteOverspent"]);

/** A venue's own revert reason, from the bytes the governor wrapped it in. */
export function venueReason(bytes: string): string {
  if (!bytes || bytes === "0x") return "no reason given";
  try {
    if (bytes.startsWith("0x08c379a0")) {
      return String(ethers.AbiCoder.defaultAbiCoder().decode(["string"], ethers.dataSlice(bytes, 4))[0]);
    }
    if (bytes.startsWith("0x4e487b71")) return `panic ${BigInt(ethers.dataSlice(bytes, 4, 36))}`;
  } catch {
    // malformed; shown raw below
  }
  return `raw ${bytes.slice(0, 74)}`;
}

/**
 * A governor refusal, with its amounts in the units they are in. The SDK's
 * decoder prints every amount as ETH, which would turn a USDC shortfall into a
 * number with twelve leading zeros.
 */
export function refusalOf(err: unknown, tokenDecimals = 18): { code: string; detail: string } | null {
  const e = err as { data?: unknown; info?: { error?: { data?: unknown } }; error?: { data?: unknown } };
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  return typeof data === "string" ? refusalOfData(data, tokenDecimals) : null;
}

export function refusalOfData(data: string, tokenDecimals = 18): { code: string; detail: string } | null {
  let parsed: ethers.ErrorDescription | null = null;
  try {
    parsed = REFUSAL_ERRORS.parseError(data);
  } catch {
    return null;
  }
  if (!parsed) return null;
  if (parsed.name === "VenueCallFailed") return { code: parsed.name, detail: `VenueCallFailed: ${venueReason(String(parsed.args[0]))}` };
  const fields = parsed.fragment.inputs.map((input, i) => {
    const value = parsed!.args[i];
    if (typeof value !== "bigint") return `${input.name}=${String(value)}`;
    if (ETH_REFUSALS.has(parsed!.name)) return `${input.name}=${ethers.formatEther(value)} ETH`;
    if (parsed!.name === "MinimumOutputNotMet") return `${input.name}=${ethers.formatUnits(value, tokenDecimals)}`;
    return `${input.name}=${value}`;
  });
  return { code: parsed.name, detail: fields.length ? `${parsed.name}: ${fields.join(", ")}` : parsed.name };
}

type Result = Record<string, unknown>;

function refused(code: string, detail: string): Result {
  return { ok: false, refused: code, detail, meaning: REFUSALS[code] ?? "The governor refused this spend." };
}

// ------------------------------------------------------------------ chain reads

/** An endpoint's answer that means "not now", as opposed to "no". */
export function isRateLimit(error: { code?: number; message?: string } | undefined): boolean {
  return Boolean(error) && (error!.code === -32016 || error!.code === 429 || /rate limit|too many requests/i.test(error!.message ?? ""));
}

/**
 * A provider that waits out a rate limit instead of failing on it.
 *
 * The default endpoint, mainnet.base.org, limits requests per IP and answers
 * the excess with -32016, which ethers reports as "missing revert data": a
 * status read of fifteen values failed that way on its first run against
 * mainnet. Requests go one per HTTP call, so a retry repeats only the request
 * that was refused; repeating a refused eth_sendRawTransaction is safe, since
 * the node did not take it.
 */
export class PatientProvider extends ethers.JsonRpcProvider {
  constructor(url: string, chainId: number, private readonly waits = [1_000, 3_000, 6_000, 10_000]) {
    const req = new ethers.FetchRequest(url);
    req.timeout = 20_000;
    super(req, ethers.Network.from(BigInt(chainId)), { staticNetwork: true, batchMaxCount: 1 });
  }

  // Typed by ethers as results only; error entries come back through here too.
  override async _send(payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[]): Promise<ethers.JsonRpcResult[]> {
    for (let attempt = 0; ; attempt += 1) {
      const results = await super._send(payload);
      const limited = results.some((r) => isRateLimit((r as unknown as { error?: { code?: number; message?: string } }).error));
      if (!limited || attempt >= this.waits.length) return results;
      await new Promise((resolve) => setTimeout(resolve, this.waits[attempt]));
    }
  }
}

function providerFor(settings: Settings): ethers.JsonRpcProvider {
  return new PatientProvider(settings.rpcUrl, settings.chainId);
}

const ERC20 = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];

async function tokenInfo(provider: ethers.Provider, token: string): Promise<{ address: string; decimals: number; symbol: string }> {
  if (!ethers.isAddress(token)) throw new CliError("BAD_ARGUMENT", "--token must be a token address");
  const erc20 = new ethers.Contract(token, ERC20, provider);
  let decimals: bigint;
  try {
    decimals = await erc20.decimals();
  } catch (err) {
    // Only an address with no code is "not a token". Anything else is the
    // endpoint failing, and saying otherwise would send an agent off to
    // doubt a token that is fine.
    if ((await provider.getCode(token)) === "0x") {
      throw new CliError("BAD_ARGUMENT", `${token} has no contract on this chain; it is not a token`);
    }
    throw err;
  }
  const symbol = await erc20.symbol().catch(() => "TOKEN");
  return { address: ethers.getAddress(token), decimals: Number(decimals), symbol: String(symbol) };
}

interface AgentState {
  id: bigint;
  owner: string;
  operator: string;
  suspended: boolean;
  epochLength: number;
  name: string;
}

async function readAgent(governor: ethers.Contract, id: bigint): Promise<AgentState> {
  const info = await governor.agents(id);
  if (info.owner === ethers.ZeroAddress) throw new CliError("UnknownAgent", `agent ${id} does not exist on this governor`);
  let name = `agent-${id}`;
  try {
    name = String(JSON.parse(info.metadataURI).name ?? name);
  } catch {
    // an agent registered without JSON metadata keeps its number as its name
  }
  return { id, owner: info.owner, operator: info.operator, suspended: info.suspended, epochLength: Number(info.epochLength), name };
}

/**
 * The endpoint must be the chain the governor is on. An RPC for another chain
 * would answer every read about these addresses with nothing, and a key used
 * there spends that chain's money.
 */
async function checkChain(provider: ethers.JsonRpcProvider, settings: Settings): Promise<void> {
  // Asked of the endpoint itself: the provider's network is fixed, so it
  // does not ask again on every call.
  const chainId = BigInt(await provider.send("eth_chainId", []));
  if (chainId !== BigInt(settings.chainId)) {
    throw new CliError("WRONG_CHAIN", `the RPC serves chain ${chainId}, not ${settings.chainId} (Base)`);
  }
}

// ------------------------------------------------------------------ context

export interface Context {
  settings: Settings;
  provider: ethers.JsonRpcProvider;
  /** Present for commands that sign. */
  wallet?: ethers.Wallet;
  address?: string;
  now?: () => Date;
}

export async function contextFor(flags: Record<string, string>, signing: boolean, env: NodeJS.ProcessEnv = process.env): Promise<Context> {
  const settings = settingsFrom(flags, env);
  const provider = providerFor(settings);
  await checkChain(provider, settings);
  if (!signing) return { settings, provider };
  const wallet = new ethers.Wallet(loadKey(settings.keyFile, env), provider);
  return { settings, provider, wallet, address: wallet.address };
}

function governorOf(ctx: Context, signed = false): ethers.Contract {
  return new ethers.Contract(ctx.settings.governor, QUAESTOR_V2_ABI, signed ? ctx.wallet! : ctx.provider);
}

function stateDir(ctx: Pick<Context, "settings">): string {
  return path.dirname(ctx.settings.keyFile);
}

// ------------------------------------------------------------------ sending a spend

/**
 * A spend that has been signed and may be on its way. Written before the
 * transaction is broadcast, with the signed bytes, so that whatever happens to
 * the connection the agent knows the one transaction it may have sent, can
 * send that same transaction again safely (same nonce, same hash), and sends
 * no other spend until it knows what this one did.
 */
export interface PendingSpend {
  hash: string;
  raw: string;
  nonce: number;
  kind: "buy" | "pay";
  agent: string;
  meta: DecisionMeta;
  metaHash: string;
  tokenDecimals: number;
  sentAt: string;
}

function pendingPath(ctx: Pick<Context, "settings">): string {
  return path.join(stateDir(ctx), "pending.json");
}

export function readPending(file: string): PendingSpend | null {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as PendingSpend) : null;
}

function writePending(ctx: Context, pending: PendingSpend): void {
  fs.mkdirSync(stateDir(ctx), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pendingPath(ctx), JSON.stringify(pending, null, 2), { mode: 0o600 });
  fs.mkdirSync(path.join(stateDir(ctx), "records"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir(ctx), "records", `${pending.hash}.json`), JSON.stringify({ txHash: pending.hash, metaHash: pending.metaHash, meta: pending.meta }, null, 2));
}

function clearPending(ctx: Context): void {
  fs.rmSync(pendingPath(ctx), { force: true });
}

/** No new spend while an earlier one is unsettled: sending again could spend twice. */
export function refuseIfPending(ctx: Pick<Context, "settings">): Result | null {
  const pending = readPending(pendingPath(ctx));
  if (!pending) return null;
  return {
    ok: false,
    error: "PENDING_SPEND",
    tx: `${BASE.explorerTx}${pending.hash}`,
    message: `an earlier ${pending.kind} (${pending.hash}) has not been settled. Run "check" before any new spend; do not repeat it.`,
  };
}

/**
 * Whether the node answered a broadcast with a refusal of its own. A node
 * that answered has decided: the transaction is not in its pool and was not
 * sent. Only a failure with no answer at all (a dropped connection, a
 * timeout) leaves the outcome unknown.
 */
export function nodeRefused(err: unknown): string | null {
  const e = err as { code?: string; error?: { code?: number; message?: string }; info?: { error?: { code?: number; message?: string } }; shortMessage?: string };
  if (["INSUFFICIENT_FUNDS", "NONCE_EXPIRED", "REPLACEMENT_UNDERPRICED"].includes(e?.code ?? "")) return e.shortMessage ?? e.code!;
  const answer = e?.info?.error ?? e?.error;
  if (answer && typeof answer.code === "number") return answer.message ?? `the node answered ${answer.code}`;
  return null;
}

/**
 * Sign, record, broadcast and wait. The answer is one of: settled (with its
 * receipt), refused in the block (decoded from the chain), not sent (the node
 * said so, and nothing is pending), or unconfirmed (the hash is known and
 * recorded, the outcome is not, and `check` will settle it).
 */
async function sendSpend(
  ctx: Context,
  request: ethers.ContractTransaction,
  record: Omit<PendingSpend, "hash" | "raw" | "nonce" | "sentAt">,
): Promise<{ state: "settled"; receipt: ethers.TransactionReceipt; hash: string }
  | { state: "refused"; refusal: Result; hash: string }
  | { state: "not-sent"; message: string }
  | { state: "unconfirmed"; hash: string }> {
  const populated = await ctx.wallet!.populateTransaction(request);
  // The node wants the whole worst-case fee up front, not the fee it will
  // charge. Say so now rather than sign a spend it will refuse.
  const upfront = BigInt(populated.gasLimit ?? 0n) * BigInt(populated.maxFeePerGas ?? populated.gasPrice ?? 0n);
  const gas = await ctx.provider.getBalance(ctx.address!);
  if (gas < upfront) {
    return { state: "not-sent", message: `the operator holds ${ethers.formatEther(gas)} ETH and this spend needs up to ${ethers.formatEther(upfront)} ETH of gas up front; nothing was sent` };
  }
  const raw = await ctx.wallet!.signTransaction(populated);
  const hash = ethers.keccak256(raw);
  writePending(ctx, { ...record, hash, raw, nonce: Number(populated.nonce), sentAt: (ctx.now?.() ?? new Date()).toISOString() });
  try {
    await ctx.provider.broadcastTransaction(raw);
  } catch (err) {
    const known = await ctx.provider.getTransaction(hash).catch(() => null);
    const refusedBy = nodeRefused(err);
    if (!known && refusedBy) {
      clearPending(ctx);
      return { state: "not-sent", message: `the node refused it (${refusedBy.slice(0, 160)}); nothing was sent` };
    }
    if (!known) return { state: "unconfirmed", hash };
  }
  return settle(ctx, hash, record.tokenDecimals);
}

/** What a known transaction did, if the chain says yet. */
async function settle(ctx: Context, hash: string, tokenDecimals: number, waitMs = CONFIRM_MS) {
  const receipt = await ctx.provider.waitForTransaction(hash, 1, waitMs).catch(() => null);
  if (!receipt) return { state: "unconfirmed" as const, hash };
  clearPending(ctx);
  if (receipt.status === 1) return { state: "settled" as const, receipt, hash };
  return { state: "refused" as const, refusal: await revertOf(ctx, hash, receipt, tokenDecimals), hash };
}

/**
 * Why a mined transaction reverted. The simulation before sending can pass and
 * the block still refuse (a cap reached by another spend in between, a price
 * that moved), and a reverted receipt carries no reason, so the same call is
 * replayed against the state just before its block.
 */
async function revertOf(ctx: Context, hash: string, receipt: ethers.TransactionReceipt, tokenDecimals: number): Promise<Result> {
  const tx = await ctx.provider.getTransaction(hash);
  try {
    await ctx.provider.call({ to: tx!.to, from: tx!.from, data: tx!.data, value: tx!.value, blockTag: receipt.blockNumber - 1 });
  } catch (err) {
    const refusal = refusalOf(err, tokenDecimals);
    if (refusal) return refused(refusal.code, refusal.detail);
  }
  return { ok: false, refused: "Reverted", detail: `the transaction reverted in block ${receipt.blockNumber} and the reason could not be recovered`, meaning: "Nothing was spent except gas." };
}

/**
 * Put the record behind a settled spend on chain, then hand it to the ledger
 * so the explorer can open it before the indexer catches up. Only after the
 * spend settled: a refused spend has no receipt pointing at its record.
 */
async function publishRecord(ctx: Context, meta: DecisionMeta, metaHash: string): Promise<{ recordTx?: string; recordSkipped?: string }> {
  const text = JSON.stringify(meta);
  const key = ctx.wallet!.privateKey.slice(2).toLowerCase();
  const leaked = credentialIn(text) ?? (text.toLowerCase().includes(key) ? "the operator key" : null);
  if (leaked) return { recordSkipped: `not published: it looks like it contains ${leaked}` };
  const bytes = ethers.toUtf8Bytes(text);
  if (ethers.keccak256(bytes) !== metaHash) return { recordSkipped: "not published: the record does not hash to the committed metaHash" };
  let recordTx: string | undefined;
  try {
    const log = new ethers.Contract(ctx.settings.log, QUAESTOR_LOG_ABI, ctx.wallet!);
    const tx = await log.publish(bytes);
    recordTx = (await tx.wait(1, CONFIRM_MS))?.hash ?? tx.hash;
  } catch (err) {
    return { recordSkipped: `publish failed: ${((err as Error).message ?? String(err)).slice(0, 120)}` };
  }
  if (ctx.settings.ledger) {
    await fetch(`${ctx.settings.ledger}/decisions`, { method: "POST", headers: { "content-type": "text/plain" }, body: text, signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  }
  return { recordTx: `${BASE.explorerTx}${recordTx}` };
}

// ------------------------------------------------------------------ commands

export async function whoami(ctx: Context): Promise<Result> {
  const gas = await ctx.provider.getBalance(ctx.address!);
  return {
    ok: true,
    operator: ctx.address,
    gasEth: ethers.formatEther(gas),
    registerUrl: registerUrl(ctx.settings.app, ctx.address!),
    note: gas === 0n ? "This key has no ETH for gas. Ask the owner to send it about 0.0003 ETH on Base." : undefined,
  };
}

/**
 * Every agent on the governor whose operator is this key. Anyone can register
 * an agent naming any operator, so each comes with its owner, and the skill
 * has the agent confirm the owner is the user before trading for it.
 */
export async function agentsOf(ctx: Context): Promise<Result> {
  const governor = governorOf(ctx);
  const next = Number(await governor.nextAgentId());
  const mine: Result[] = [];
  for (let id = 1; id < next; id += 1) {
    const agent = await readAgent(governor, BigInt(id));
    if (agent.operator.toLowerCase() === ctx.address!.toLowerCase()) {
      mine.push({ agent: id, name: agent.name, owner: agent.owner, suspended: agent.suspended });
    }
  }
  return {
    ok: true,
    operator: ctx.address,
    agents: mine,
    note: mine.length
      ? "Anyone can register an agent naming this key. Trade only for an agent whose owner is your user's wallet."
      : `No agent is operated by this key yet. Send the owner this link to register one: ${registerUrl(ctx.settings.app, ctx.address!)}`,
  };
}

export async function status(ctx: Context, id: bigint): Promise<Result> {
  const governor = governorOf(ctx);
  const agent = await readAgent(governor, id);
  const token = await tokenInfo(ctx.provider, ctx.settings.token);
  const [treasury, epoch, venueOk, tokenOk] = await Promise.all([
    governor.balanceOf(id),
    governor.currentEpoch(id),
    governor.venueAllowed(id, UNISWAP_BASE.swapRouter02),
    governor.instrumentAllowed(id, token.address),
  ]);
  const names = ["data", "inference", "execution"];
  const budgets: Result = {};
  for (const category of [0, 1, 2]) {
    const [policy, spent, remaining] = await Promise.all([
      governor.policyOf(id, category),
      governor.spentIn(id, category, epoch),
      governor.remainingBudget(id, category),
    ]);
    budgets[names[category]] = {
      perCallCapEth: ethers.formatEther(policy.perCallCap),
      epochCapEth: ethers.formatEther(policy.epochCap),
      spentThisEpochEth: ethers.formatEther(spent),
      remainingEth: ethers.formatEther(remaining),
    };
  }
  const me = ctx.address;
  return {
    ok: true,
    agent: Number(id),
    name: agent.name,
    owner: agent.owner,
    operator: agent.operator,
    thisKeyIsOperator: me ? agent.operator.toLowerCase() === me.toLowerCase() : undefined,
    suspended: agent.suspended,
    treasuryEth: ethers.formatEther(treasury),
    epoch: Number(epoch),
    epochSeconds: agent.epochLength,
    budgets,
    uniswapAllowed: venueOk,
    [`${token.symbol}Allowed`]: tokenOk,
    operatorGasEth: me ? ethers.formatEther(await ctx.provider.getBalance(me)) : undefined,
    pendingSpend: fs.existsSync(path.join(path.dirname(ctx.settings.keyFile), "pending.json")) ? "an earlier spend is unsettled: run check" : undefined,
  };
}

async function quoteFor(ctx: Context, token: { address: string }, amountIn: bigint) {
  try {
    return await bestQuote(ctx.provider, UNISWAP_BASE, token.address, amountIn);
  } catch (err) {
    if (err instanceof NoPoolError) throw new CliError("NO_POOL", err.message);
    throw err;
  }
}

export async function quote(ctx: Context, amountIn: bigint): Promise<Result> {
  const token = await tokenInfo(ctx.provider, ctx.settings.token);
  const best = await quoteFor(ctx, token, amountIn);
  return {
    ok: true,
    venue: "uniswap-v3",
    feeTier: best.fee,
    ethIn: ethers.formatEther(amountIn),
    [`${token.symbol}Out`]: ethers.formatUnits(best.amountOut, token.decimals),
    token: token.address,
  };
}

/**
 * Buy a token with ETH from the agent's treasury, through Uniswap v3.
 *
 * The price is the best of every fee tier, the floor is that quote less the
 * slippage (and never below a floor the user already approved), and it is
 * the owner's balance the governor measures, so calldata that pays anyone
 * else reverts. The spend is simulated first: a refusal costs no gas and
 * comes back as the governor's own reason. `--dry-run` stops there.
 */
export async function buy(
  ctx: Context,
  id: bigint,
  amountIn: bigint,
  reason: string,
  slippageBps: number,
  dryRun: boolean,
  approvedFloor?: string,
): Promise<Result> {
  const governor = governorOf(ctx, true);
  const state = await readAgent(governor, id);
  if (state.operator.toLowerCase() !== ctx.address!.toLowerCase()) {
    return refused("NotOperator", `agent ${id} is operated by ${state.operator}, not by this key (${ctx.address})`);
  }
  const token = await tokenInfo(ctx.provider, ctx.settings.token);
  const best = await quoteFor(ctx, token, amountIn);
  let minOut = minOutOf(best.amountOut, slippageBps);
  let pinned: bigint | undefined;
  if (approvedFloor !== undefined) {
    try {
      pinned = ethers.parseUnits(approvedFloor, token.decimals);
    } catch {
      throw new CliError("BAD_ARGUMENT", `--min-out must be an amount of ${token.symbol} such as 0.27`);
    }
    if (pinned <= 0n) throw new CliError("BAD_ARGUMENT", "--min-out must be more than zero");
  }
  const summary: Result = {
    agent: Number(id),
    ethIn: ethers.formatEther(amountIn),
    feeTier: best.fee,
    [`${token.symbol}Quoted`]: ethers.formatUnits(best.amountOut, token.decimals),
    [`${token.symbol}Floor`]: ethers.formatUnits(minOut, token.decimals),
    recipient: state.owner,
  };
  if (pinned !== undefined) {
    if (minOut < pinned) {
      return { ...refused("PriceMoved", `the fresh floor is ${ethers.formatUnits(minOut, token.decimals)} ${token.symbol}, below the approved ${approvedFloor}`), ...summary };
    }
    minOut = minOut > pinned ? minOut : pinned;
  }
  const meta: DecisionMeta = {
    agent: state.name,
    action: "buy",
    rationale: reason,
    inputs: {
      venue: "uniswap-v3",
      feeTier: best.fee,
      tokenOut: token.address,
      amountInWei: amountIn.toString(),
      quotedOut: best.amountOut.toString(),
      minOut: minOut.toString(),
      slippageBps,
    },
    timestamp: (ctx.now?.() ?? new Date()).toISOString(),
  };
  const metaHash = metaHashOf(meta);
  const swapData = exactInputSingleData(UNISWAP_BASE, token.address, state.owner, amountIn, minOut, best.fee);
  const args = [id, UNISWAP_BASE.swapRouter02, swapData, token.address, amountIn, minOut, metaHash] as const;
  Object.assign(summary, { [`${token.symbol}Floor`]: ethers.formatUnits(minOut, token.decimals), metaHash });

  const refusal = await simulate(() => governor.swap.staticCall(...args), token.decimals);
  if (refusal) return { ...refusal, ...summary };
  const noGas = await gasCheck(ctx);
  if (noGas) return { ...noGas, ...summary };
  if (dryRun) return { ok: true, dryRun: true, wouldSettle: true, ...summary };

  const sent = await sendSpend(ctx, await governor.swap.populateTransaction(...args), {
    kind: "buy", agent: String(id), meta, metaHash, tokenDecimals: token.decimals,
  });
  return finish(ctx, sent, summary, meta, metaHash, (receipt) => {
    const executed = receipt.logs
      .map((log) => { try { return governor.interface.parseLog(log); } catch { return null; } })
      .find((parsed) => parsed?.name === "SwapExecuted");
    return executed ? { [`${token.symbol}Received`]: ethers.formatUnits(executed.args.amountOut as bigint, token.decimals) } : {};
  });
}

/** Pay for a service (data or inference) from the treasury, with the reason on chain. */
export async function pay(ctx: Context, id: bigint, category: "data" | "inference", payee: string, amount: bigint, reason: string, dryRun: boolean): Promise<Result> {
  const to = checkPayee(payee, ctx.settings, ctx.address!);
  const governor = governorOf(ctx, true);
  const state = await readAgent(governor, id);
  if (state.operator.toLowerCase() !== ctx.address!.toLowerCase()) {
    return refused("NotOperator", `agent ${id} is operated by ${state.operator}, not by this key (${ctx.address})`);
  }
  const cat = category === "data" ? Category.DATA : Category.INFERENCE;
  const meta: DecisionMeta = {
    agent: state.name,
    action: `pay-${category}`,
    rationale: reason,
    inputs: { payee: to, amountWei: amount.toString() },
    timestamp: (ctx.now?.() ?? new Date()).toISOString(),
  };
  const metaHash = metaHashOf(meta);
  const args = [id, cat, to, amount, metaHash] as const;
  const summary: Result = { agent: Number(id), category, to, eth: ethers.formatEther(amount), metaHash };
  const refusal = await simulate(() => governor.pay.staticCall(...args));
  if (refusal) return { ...refusal, ...summary };
  const noGas = await gasCheck(ctx);
  if (noGas) return { ...noGas, ...summary };
  if (dryRun) return { ok: true, dryRun: true, wouldSettle: true, ...summary };
  const sent = await sendSpend(ctx, await governor.pay.populateTransaction(...args), {
    kind: "pay", agent: String(id), meta, metaHash, tokenDecimals: 18,
  });
  return finish(ctx, sent, summary, meta, metaHash, () => ({}));
}

/** Turn what a sent spend did into the command's answer, publishing the record if it settled. */
async function finish(
  ctx: Context,
  sent: Awaited<ReturnType<typeof sendSpend>>,
  summary: Result,
  meta: DecisionMeta,
  metaHash: string,
  extra: (receipt: ethers.TransactionReceipt) => Result,
): Promise<Result> {
  if (sent.state === "not-sent") return { ok: false, error: "NOT_SENT", message: sent.message, ...summary };
  if (sent.state === "unconfirmed") return unconfirmed(sent.hash, summary);
  if (sent.state === "refused") return { ...sent.refusal, tx: `${BASE.explorerTx}${sent.hash}`, ...summary };
  return {
    ok: true,
    ...summary,
    ...extra(sent.receipt),
    tx: `${BASE.explorerTx}${sent.hash}`,
    ...(await publishRecord(ctx, meta, metaHash)),
    record: `${ctx.settings.app}/#/app/decisions/${metaHash}?chain=base`,
  };
}

function unconfirmed(hash: string, summary: Result = {}): Result {
  return {
    ok: false,
    error: "UNCONFIRMED",
    tx: `${BASE.explorerTx}${hash}`,
    message: "The spend was sent and its outcome is not known yet. Do NOT send it again. Run \"check\" in a minute: it settles this one before any other spend is sent.",
    ...summary,
  };
}

/**
 * Settle an interrupted spend. Mined: report it, and publish its record if it
 * settled. In the mempool: still pending. Unknown to the node: if its nonce
 * has since been used, it can never be mined and is dropped; otherwise the
 * same signed bytes are sent again, which cannot spend twice.
 */
export async function check(ctx: Context): Promise<Result> {
  const pending = readPending(pendingPath(ctx));
  if (!pending) return { ok: true, pending: false, message: "No unsettled spend. A new one may be sent." };
  const tx = `${BASE.explorerTx}${pending.hash}`;
  const receipt = await ctx.provider.getTransactionReceipt(pending.hash);
  if (receipt) {
    const done = await settle(ctx, pending.hash, pending.tokenDecimals, 1_000);
    if (done.state === "settled") {
      return { ok: true, pending: false, settled: pending.kind, tx, ...(await publishRecord(ctx, pending.meta, pending.metaHash)), record: `${ctx.settings.app}/#/app/decisions/${pending.metaHash}?chain=base` };
    }
    if (done.state === "refused") return { ...done.refusal, pending: false, tx };
  }
  if (await ctx.provider.getTransaction(pending.hash)) {
    return { ok: false, error: "UNCONFIRMED", pending: true, tx, message: "Still waiting to be mined. Run check again in a minute; do not send it again." };
  }
  const used = await ctx.provider.getTransactionCount(ctx.address!, "latest");
  if (used > pending.nonce) {
    clearPending(ctx);
    return { ok: true, pending: false, dropped: true, tx, message: "This spend was never mined and its nonce has been used since, so it never will be. Nothing was spent. A new spend may be sent." };
  }
  try {
    await ctx.provider.broadcastTransaction(pending.raw);
  } catch (err) {
    const refusedBy = nodeRefused(err);
    if (refusedBy && !(await ctx.provider.getTransaction(pending.hash).catch(() => null))) {
      clearPending(ctx);
      return { ok: false, error: "NOT_SENT", pending: false, tx, message: `This spend never reached the chain and the node refuses it (${refusedBy.slice(0, 160)}). Nothing was spent. A new spend may be sent.` };
    }
  }
  return { ok: false, error: "UNCONFIRMED", pending: true, rebroadcast: true, tx, message: "The node had lost it, so the same signed spend was sent again; it cannot be spent twice. Run check again in a minute." };
}

async function simulate(call: () => Promise<unknown>, tokenDecimals = 18): Promise<Result | null> {
  try {
    await call();
    return null;
  } catch (err) {
    const refusal = refusalOf(err, tokenDecimals);
    if (refusal) return refused(refusal.code, refusal.detail);
    throw err;
  }
}

/** A trade needs gas the operator pays itself; say so before sending rather than after it fails. */
async function gasCheck(ctx: Context): Promise<Result | null> {
  const gas = await ctx.provider.getBalance(ctx.address!);
  if (gas >= ethers.parseEther("0.00001")) return null;
  return {
    ok: false,
    refused: "NoGas",
    detail: `the operator ${ctx.address} holds ${ethers.formatEther(gas)} ETH`,
    meaning: "The operator key pays its own gas and has almost none. The owner can send it about 0.0003 ETH on Base; that ETH is outside the governor.",
  };
}

// ------------------------------------------------------------------ entry

const HELP = `quaestor: trade on Base under a Quaestor governor

  keygen                                   make this agent's operator key (never printed)
  whoami                                   this key's address, gas, and the owner's register link
  agents                                   agents this key operates, with their owners
  status --agent <id>                      caps, spend, treasury, allowlist, gas
  quote --eth <amount>                     best Uniswap v3 quote for ETH -> USDC
  buy --agent <id> --eth <amount> --reason "<why>" [--slippage-bps 100] [--min-out <floor>] [--dry-run]
  pay --agent <id> --category data|inference --to <address> --eth <amount> --reason "<why>" [--dry-run]
  check                                    settle a spend that was sent but not confirmed

  --token <address>   buy or quote another token instead of USDC (the owner must allow it)
  --key-file <path>   operator key file (default ~/.quaestor/operator.key)
  --rpc <url>         Base RPC (default ${BASE.rpcUrl}, or QUAESTOR_RPC_URL)`;

export async function run(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; out: Result | string }> {
  try {
    const { command, flags } = parseArgs(argv);
    if (command === "--help") return { code: 0, out: HELP };
    checkFlags(command, flags);
    switch (command) {
      case "help":
        return { code: 0, out: HELP };
      case "keygen": {
        const settings = settingsFrom(flags, env);
        const { address, keyFile } = keygen(settings.keyFile, env);
        return {
          code: 0,
          out: {
            ok: true,
            operator: address,
            keyFile,
            registerUrl: registerUrl(settings.app, address),
            next: "Send the owner the registerUrl. Never share the key file. The owner also sends the operator about 0.0003 ETH on Base for gas.",
          },
        };
      }
      case "whoami":
        return { code: 0, out: await whoami(await contextFor(flags, true, env)) };
      case "agents":
        return { code: 0, out: await agentsOf(await contextFor(flags, true, env)) };
      case "status": {
        const id = agentIdOf(flags);
        const ctx = await contextFor(flags, false, env);
        // Status reads without the key, but says whether this key operates the agent when it can.
        let address: string | undefined;
        try {
          address = new ethers.Wallet(loadKey(ctx.settings.keyFile, env)).address;
        } catch {
          address = undefined;
        }
        return { code: 0, out: await status({ ...ctx, address }, id) };
      }
      case "quote":
        return { code: 0, out: await quote(await contextFor(flags, false, env), ethOf(flags)) };
      case "check":
        return exitFor(await check(await contextFor(flags, true, env)));
      case "buy": {
        const id = agentIdOf(flags);
        const amount = ethOf(flags);
        const slippage = slippageOf(flags);
        reasonOf(flags); // everything that can be checked without the chain, first
        const ctx = await contextFor(flags, true, env);
        const reason = reasonOf(flags, ctx.wallet!.privateKey);
        const blocked = refuseIfPending(ctx);
        if (blocked) return { code: 1, out: blocked };
        return exitFor(await buy(ctx, id, amount, reason, slippage, flags["dry-run"] === "true", flags["min-out"]));
      }
      case "pay": {
        const id = agentIdOf(flags);
        const category = required(flags, "category");
        if (category !== "data" && category !== "inference") {
          throw new CliError("BAD_ARGUMENT", "--category must be data or inference; trades go through buy");
        }
        const amount = ethOf(flags);
        const payee = required(flags, "to");
        reasonOf(flags);
        const ctx = await contextFor(flags, true, env);
        const reason = reasonOf(flags, ctx.wallet!.privateKey);
        const blocked = refuseIfPending(ctx);
        if (blocked) return { code: 1, out: blocked };
        return exitFor(await pay(ctx, id, category, payee, amount, reason, flags["dry-run"] === "true"));
      }
      default:
        throw new CliError("UNKNOWN_COMMAND", `unknown command "${command}"; run "help"`);
    }
  } catch (err) {
    if (err instanceof CliError) {
      // An agent id that does not exist is the chain's answer, reported like any other refusal.
      if (REFUSALS[err.code]) return { code: 2, out: refused(err.code, err.message) };
      return { code: 1, out: { ok: false, error: err.code, message: err.message } };
    }
    const refusal = refusalOf(err);
    if (refusal) return { code: 2, out: refused(refusal.code, refusal.detail) };
    // What the endpoint said, which ethers folds into "missing revert data".
    const e = err as { info?: { error?: { code?: number; message?: string } }; shortMessage?: string; message?: string };
    const said = e.info?.error;
    const message = said ? `the endpoint said ${said.code ?? ""} ${said.message ?? ""}`.trim() : (e.shortMessage ?? e.message ?? String(err));
    return { code: 1, out: { ok: false, error: isRateLimit(said) ? "RATE_LIMITED" : "FAILED", message: message.slice(0, 300) } };
  }
}

/** 0 for success, 2 for a refusal, 1 for anything else (including an unconfirmed spend). */
function exitFor(out: Result): { code: number; out: Result } {
  if (out.ok) return { code: 0, out };
  return { code: out.refused ? 2 : 1, out };
}

// Run when executed directly, not when imported by a test.
const invoked = process.argv[1] ?? "";
if (/quaestor\.(ts|mjs|js)$/.test(invoked)) {
  void run(process.argv.slice(2)).then(({ code, out }) => {
    process.stdout.write(typeof out === "string" ? `${out}\n` : `${JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
    process.exitCode = code;
  });
}
