/**
 * quaestor: the one command an agent runs to trade on Base under a governor.
 *
 *   node quaestor.mjs keygen                      make this agent's operator key
 *   node quaestor.mjs agents                      which agents this key operates
 *   node quaestor.mjs status --agent 7            caps, spend, treasury, gas
 *   node quaestor.mjs quote --eth 0.0001          what Uniswap gives for it now
 *   node quaestor.mjs buy --agent 7 --eth 0.0001 --reason "..."
 *   node quaestor.mjs pay --agent 7 --category data --to 0x… --eth 0.00001 --reason "..."
 *
 * The agent holds its own operator key, in a file only it reads. That key can
 * do one thing: spend through the governor, inside the caps its owner set, to
 * venues and tokens its owner allowed, with whatever it buys landing in the
 * owner's wallet. The owner registers the agent from their own wallet in the
 * app, and nothing here ever sees the owner's key.
 *
 * Every command prints one JSON object. A refusal is not an error: it exits 2
 * and says in plain words what the governor refused and what to do about it.
 */
import { ethers } from "ethers";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  Category,
  QUAESTOR_LOG_ABI,
  QUAESTOR_V2_ABI,
  QuaestorAgent,
  credentialIn,
  metaHashOf,
  type DecisionMeta,
} from "../sdk/evm";
import { UNISWAP_BASE, exactInputSingleData, quoteExactInputSingle } from "../sdk/uniswap";

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

/** What each refusal means, and what an agent should do next. Never "try again with more". */
export const REFUSALS: Record<string, string> = {
  PerCallCapExceeded: "Bigger than one action may spend. Spend less, or ask the owner to raise the per-call cap.",
  EpochCapExceeded: "This period's budget for this purpose is used up. Wait for the next epoch; only the owner can raise the cap.",
  InsufficientTreasury: "The treasury holds less than this. Ask the owner to deposit.",
  VenueNotAllowed: "The owner has not allowed this venue. Only the owner can allow it.",
  InstrumentNotAllowed: "The owner has not allowed this token. Only the owner can allow it.",
  AgentIsSuspended: "The owner or the guardian has suspended this agent. Stop and tell the owner.",
  NotOperator: "This key is not the agent's operator. Check the agent id, or ask the owner to set this key as operator.",
  UnknownAgent: "No agent has this id.",
  ZeroAmount: "An amount or the minimum output came out as zero.",
  MinimumOutputNotMet: "Less than the minimum reached the owner: the price moved past the slippage, or the route paid someone else. Do not widen the slippage to force it through.",
  RouteOverspent: "The venue took more than the amount authorised, so the whole trade was undone.",
  VenueCallFailed: "The venue itself failed. Quote again; if it keeps failing, report it.",
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

/** `buy --agent 7 --eth 0.001` → { command: "buy", flags: { agent: "7", eth: "0.001" } }. */
export function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) throw new CliError("BAD_ARGUMENT", `unexpected argument "${token}"`);
    const [name, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) flags[name] = inline;
    else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) flags[name] = rest[++i];
    else flags[name] = "true";
  }
  return { command, flags };
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
 * present, short, and carrying nothing that looks like a credential.
 */
export function reasonOf(flags: Record<string, string>): string {
  const reason = required(flags, "reason").trim();
  if (!reason) throw new CliError("MISSING_ARGUMENT", "--reason is required: it is published on chain with the spend");
  if (reason.length > MAX_REASON_CHARS) throw new CliError("BAD_ARGUMENT", `--reason may be at most ${MAX_REASON_CHARS} characters`);
  const leaked = credentialIn(reason);
  if (leaked) throw new CliError("REASON_LOOKS_SECRET", `--reason looks like it contains ${leaked}; it would be published on chain, so it was not sent`);
  return reason;
}

/** The owner's floor: the quote less the slippage, never zero. */
export function minOutOf(quoted: bigint, slippageBps: number): bigint {
  const minOut = (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minOut <= 0n) throw new CliError("QUOTE_TOO_SMALL", "the quote is too small to set a minimum output above zero; spend more");
  return minOut;
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
 * strand the agent until the owner sets a new operator.
 */
export function keygen(keyFile: string): { address: string; keyFile: string } {
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

// ------------------------------------------------------------------ chain reads

function providerFor(rpcUrl: string): ethers.JsonRpcProvider {
  const req = new ethers.FetchRequest(rpcUrl);
  req.timeout = 20_000;
  return new ethers.JsonRpcProvider(req, undefined, { staticNetwork: false });
}

const ERC20 = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];

async function tokenInfo(provider: ethers.Provider, token: string): Promise<{ address: string; decimals: number; symbol: string }> {
  const erc20 = new ethers.Contract(token, ERC20, provider);
  const [decimals, symbol] = await Promise.all([erc20.decimals(), erc20.symbol().catch(() => "TOKEN")]);
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

const REFUSAL_ERRORS = new ethers.Interface(
  [...QUAESTOR_V2_ABI, ...QUAESTOR_LOG_ABI].filter((line) => line.startsWith("error ")),
);
/** Refusals whose amounts are ETH out of the treasury; MinimumOutputNotMet's are the token's. */
const ETH_REFUSALS = new Set(["PerCallCapExceeded", "EpochCapExceeded", "InsufficientTreasury", "RouteOverspent"]);

/**
 * A governor refusal, with its amounts in the units they are in. The SDK's
 * decoder prints every amount as ETH, which would turn a USDC shortfall into a
 * number with twelve leading zeros.
 */
export function refusalOf(err: unknown, tokenDecimals = 18): { code: string; detail: string } | null {
  const e = err as { data?: unknown; info?: { error?: { data?: unknown } }; error?: { data?: unknown } };
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (typeof data !== "string") return null;
  let parsed: ethers.ErrorDescription | null = null;
  try {
    parsed = REFUSAL_ERRORS.parseError(data);
  } catch {
    return null;
  }
  if (!parsed) return null;
  const fields = parsed.fragment.inputs.map((input, i) => {
    const value = parsed!.args[i];
    if (typeof value !== "bigint") return `${input.name}=${String(value)}`;
    if (ETH_REFUSALS.has(parsed!.name)) return `${input.name}=${ethers.formatEther(value)} ETH`;
    if (parsed!.name === "MinimumOutputNotMet") return `${input.name}=${ethers.formatUnits(value, tokenDecimals)}`;
    return `${input.name}=${value}`;
  });
  return { code: parsed.name, detail: fields.length ? `${parsed.name}: ${fields.join(", ")}` : parsed.name };
}

// ------------------------------------------------------------------ commands

type Result = Record<string, unknown>;

export interface Context {
  settings: Settings;
  provider: ethers.Provider;
  /** Present for commands that sign. */
  agent?: QuaestorAgent;
  address?: string;
  now?: () => Date;
}

/**
 * The endpoint must be the chain the governor is on. An RPC for another chain
 * would answer every read about these addresses with nothing, and a key used
 * there spends that chain's money.
 */
async function checkChain(provider: ethers.Provider, settings: Settings): Promise<void> {
  const { chainId } = await provider.getNetwork();
  if (chainId !== BigInt(settings.chainId)) {
    throw new CliError("WRONG_CHAIN", `the RPC serves chain ${chainId}, not ${settings.chainId} (Base)`);
  }
}

export async function contextFor(flags: Record<string, string>, signing: boolean, env: NodeJS.ProcessEnv = process.env): Promise<Context> {
  const settings = settingsFrom(flags, env);
  if (!signing) {
    const provider = providerFor(settings.rpcUrl);
    await checkChain(provider, settings);
    return { settings, provider };
  }
  const key = loadKey(settings.keyFile, env);
  const agent = new QuaestorAgent({
    rpcUrl: settings.rpcUrl,
    quaestorAddress: settings.governor,
    privateKey: key,
    governorVersion: 2,
    logAddress: settings.log,
    decisionLedgerUrl: settings.ledger,
    receiptDir: path.join(path.dirname(settings.keyFile), "records"),
  });
  await checkChain(agent.provider, settings);
  return { settings, provider: agent.provider, agent, address: new ethers.Wallet(key).address };
}

export async function whoami(ctx: Context): Promise<Result> {
  const gas = await ctx.provider.getBalance(ctx.address!);
  return {
    ok: true,
    operator: ctx.address,
    gasEth: ethers.formatEther(gas),
    registerUrl: registerUrl(ctx.settings.app, ctx.address!),
    note: gas === 0n ? "This key has no ETH for gas. Send it about 0.0003 ETH on Base before trading." : undefined,
  };
}

/** Every agent on the governor whose operator is this key. */
export async function agentsOf(ctx: Context): Promise<Result> {
  const governor = new ethers.Contract(ctx.settings.governor, QUAESTOR_V2_ABI, ctx.provider);
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
    note: mine.length ? undefined : `No agent is operated by this key yet. Send the owner this link to register one: ${registerUrl(ctx.settings.app, ctx.address!)}`,
  };
}

export async function status(ctx: Context, id: bigint): Promise<Result> {
  const governor = new ethers.Contract(ctx.settings.governor, QUAESTOR_V2_ABI, ctx.provider);
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
  };
}

export async function quote(ctx: Context, amountIn: bigint): Promise<Result> {
  const token = await tokenInfo(ctx.provider, ctx.settings.token);
  const out = await quoteExactInputSingle(ctx.provider, UNISWAP_BASE, token.address, amountIn);
  return {
    ok: true,
    venue: "uniswap-v3",
    ethIn: ethers.formatEther(amountIn),
    [`${token.symbol}Out`]: ethers.formatUnits(out, token.decimals),
    token: token.address,
  };
}

/**
 * Buy a token with ETH from the agent's treasury, through Uniswap v3.
 *
 * The floor comes from Uniswap's own quote less the slippage, and it is the
 * owner's balance the governor measures, so calldata that pays anyone else
 * reverts. The spend is simulated first: a refusal costs no gas and comes back
 * as the governor's own reason. `--dry-run` stops there.
 */
export async function buy(ctx: Context, id: bigint, amountIn: bigint, reason: string, slippageBps: number, dryRun: boolean): Promise<Result> {
  const agent = ctx.agent!;
  const governor = new ethers.Contract(ctx.settings.governor, QUAESTOR_V2_ABI, ctx.provider);
  const state = await readAgent(governor, id);
  if (state.operator.toLowerCase() !== ctx.address!.toLowerCase()) {
    return refused("NotOperator", `agent ${id} is operated by ${state.operator}, not by this key (${ctx.address})`);
  }
  const token = await tokenInfo(ctx.provider, ctx.settings.token);
  const quoted = await quoteExactInputSingle(ctx.provider, UNISWAP_BASE, token.address, amountIn);
  const minOut = minOutOf(quoted, slippageBps);
  const meta: DecisionMeta = {
    agent: state.name,
    action: "buy",
    rationale: reason,
    inputs: {
      venue: "uniswap-v3",
      tokenOut: token.address,
      amountInWei: amountIn.toString(),
      quotedOut: quoted.toString(),
      minOut: minOut.toString(),
      slippageBps,
    },
    timestamp: (ctx.now?.() ?? new Date()).toISOString(),
  };
  const swapData = exactInputSingleData(UNISWAP_BASE, token.address, state.owner, amountIn, minOut);
  const summary = {
    agent: Number(id),
    ethIn: ethers.formatEther(amountIn),
    [`${token.symbol}Quoted`]: ethers.formatUnits(quoted, token.decimals),
    [`${token.symbol}Floor`]: ethers.formatUnits(minOut, token.decimals),
    recipient: state.owner,
    metaHash: metaHashOf(meta),
  };

  const refusal = await simulate(
    () => agent.quaestor.swap.staticCall(id, UNISWAP_BASE.swapRouter02, swapData, token.address, amountIn, minOut, metaHashOf(meta)),
    token.decimals,
  );
  if (refusal) return { ...refusal, ...summary };
  const noGas = await gasCheck(ctx);
  if (noGas) return { ...noGas, ...summary };
  if (dryRun) return { ok: true, dryRun: true, wouldSettle: true, ...summary };

  const result = await agent.swapThrough(id, UNISWAP_BASE.swapRouter02, swapData, token.address, amountIn, minOut, meta);
  return {
    ok: true,
    ...summary,
    [`${token.symbol}Received`]: result.amountOut !== undefined ? ethers.formatUnits(result.amountOut, token.decimals) : undefined,
    tx: `${BASE.explorerTx}${result.txHash}`,
    recordTx: result.recordTx ? `${BASE.explorerTx}${result.recordTx}` : undefined,
    recordSkipped: result.recordSkipped,
    record: `${ctx.settings.app}/#/app/decisions/${result.metaHash}?chain=base`,
  };
}

/** Pay for a service (data or inference) from the treasury, with the reason on chain. */
export async function pay(ctx: Context, id: bigint, category: "data" | "inference", payee: string, amount: bigint, reason: string): Promise<Result> {
  const agent = ctx.agent!;
  if (!ethers.isAddress(payee)) throw new CliError("BAD_ARGUMENT", "--to must be an address");
  const governor = new ethers.Contract(ctx.settings.governor, QUAESTOR_V2_ABI, ctx.provider);
  const state = await readAgent(governor, id);
  if (state.operator.toLowerCase() !== ctx.address!.toLowerCase()) {
    return refused("NotOperator", `agent ${id} is operated by ${state.operator}, not by this key (${ctx.address})`);
  }
  const cat = category === "data" ? Category.DATA : Category.INFERENCE;
  const meta: DecisionMeta = {
    agent: state.name,
    action: `pay-${category}`,
    rationale: reason,
    inputs: { payee: ethers.getAddress(payee), amountWei: amount.toString() },
    timestamp: (ctx.now?.() ?? new Date()).toISOString(),
  };
  const summary = { agent: Number(id), category, to: ethers.getAddress(payee), eth: ethers.formatEther(amount), metaHash: metaHashOf(meta) };
  const refusal = await simulate(() => agent.quaestor.pay.staticCall(id, cat, payee, amount, metaHashOf(meta)));
  if (refusal) return { ...refusal, ...summary };
  const noGas = await gasCheck(ctx);
  if (noGas) return { ...noGas, ...summary };
  const result = await agent.pay(id, cat, payee, amount, meta);
  return {
    ok: true,
    ...summary,
    tx: `${BASE.explorerTx}${result.txHash}`,
    recordTx: result.recordTx ? `${BASE.explorerTx}${result.recordTx}` : undefined,
    recordSkipped: result.recordSkipped,
    record: `${ctx.settings.app}/#/app/decisions/${result.metaHash}?chain=base`,
  };
}

function refused(code: string, detail: string): Result {
  return { ok: false, refused: code, detail, meaning: REFUSALS[code] ?? "The governor refused this spend." };
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
    meaning: "The operator key pays its own gas and has almost none. Send it about 0.0003 ETH on Base; that ETH is outside the governor.",
  };
}

// ------------------------------------------------------------------ entry

const HELP = `quaestor: trade on Base under a Quaestor governor

  keygen                                   make this agent's operator key (never printed)
  whoami                                   this key's address, gas, and the owner's register link
  agents                                   agents this key operates
  status --agent <id>                      caps, spend, treasury, allowlist, gas
  quote --eth <amount>                     Uniswap v3 quote for ETH -> USDC
  buy --agent <id> --eth <amount> --reason "<why>" [--slippage-bps 100] [--dry-run]
  pay --agent <id> --category data|inference --to <address> --eth <amount> --reason "<why>"

  --token <address>   buy or quote another token instead of USDC (the owner must allow it)
  --key-file <path>   operator key file (default ~/.quaestor/operator.key)
  --rpc <url>         Base RPC (default ${BASE.rpcUrl}, or QUAESTOR_RPC_URL)`;

export async function run(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; out: Result | string }> {
  try {
    const { command, flags } = parseArgs(argv);
    switch (command) {
      case "keygen": {
        const { address, keyFile } = keygen(settingsFrom(flags, env).keyFile);
        return {
          code: 0,
          out: {
            ok: true,
            operator: address,
            keyFile,
            registerUrl: registerUrl(settingsFrom(flags, env).app, address),
            next: "Send the owner the registerUrl. Never share the key file. Fund the operator with about 0.0003 ETH on Base for gas.",
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
        const settings = ctx.settings;
        let address: string | undefined;
        try {
          address = new ethers.Wallet(loadKey(settings.keyFile, env)).address;
        } catch {
          address = undefined;
        }
        return { code: 0, out: await status({ ...ctx, address }, id) };
      }
      case "quote":
        return { code: 0, out: await quote(await contextFor(flags, false, env), ethOf(flags)) };
      case "buy": {
        const id = agentIdOf(flags);
        const amount = ethOf(flags);
        const reason = reasonOf(flags);
        const slippage = slippageOf(flags);
        const out = await buy(await contextFor(flags, true, env), id, amount, reason, slippage, flags["dry-run"] === "true");
        return { code: out.ok ? 0 : 2, out };
      }
      case "pay": {
        const id = agentIdOf(flags);
        const category = required(flags, "category");
        if (category !== "data" && category !== "inference") {
          throw new CliError("BAD_ARGUMENT", "--category must be data or inference; trades go through buy");
        }
        const out = await pay(await contextFor(flags, true, env), id, category, required(flags, "to"), ethOf(flags), reasonOf(flags));
        return { code: out.ok ? 0 : 2, out };
      }
      case "help":
      case "--help":
        return { code: 0, out: HELP };
      default:
        throw new CliError("UNKNOWN_COMMAND", `unknown command "${command}"; run "help"`);
    }
  } catch (err) {
    if (err instanceof CliError) return { code: 1, out: { ok: false, error: err.code, message: err.message } };
    const refusal = refusalOf(err);
    if (refusal) return { code: 2, out: refused(refusal.code, refusal.detail) };
    return { code: 1, out: { ok: false, error: "FAILED", message: ((err as Error).message ?? String(err)).slice(0, 300) } };
  }
}

// Run when executed directly, not when imported by a test.
const invoked = process.argv[1] ?? "";
if (/quaestor\.(ts|mjs|js)$/.test(invoked)) {
  void run(process.argv.slice(2)).then(({ code, out }) => {
    process.stdout.write(typeof out === "string" ? `${out}\n` : `${JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
    process.exitCode = code;
  });
}
