/**
 * quaestor-sol: the one command an agent runs to trade tokenized stocks on a
 * Solana devnet governor of its own.
 *
 *   node quaestor-sol.mjs keygen                 make this agent's key (never printed)
 *   node quaestor-sol.mjs register               the link the owner opens and signs
 *   node quaestor-sol.mjs faucet                 devnet SOL for this key's fees
 *   node quaestor-sol.mjs status                 the governor: caps, spend, vault, holdings
 *   node quaestor-sol.mjs quote --usdc 1         the curve's price and the gate's verdict
 *   node quaestor-sol.mjs buy --usdc 1 --reason "..."
 *   node quaestor-sol.mjs check                  settle a buy that was sent but not confirmed
 *
 * The agent holds its own key, and the owner's governor names it as operator.
 * That key can do one thing: execute a trade through the governor, inside the
 * owner's caps, on the venue and token the owner allowed. The program measures
 * the vault and the position around every swap and undoes one that took more
 * or delivered less than the floor. Before any buy the hub's price gate judges
 * the exact quote; the command refuses what the gate refuses. The gate runs off
 * chain, so this is the command holding itself to it, not the program.
 *
 * Every command prints one JSON object. A refusal exits 2 and says what was
 * refused; anything else that fails exits 1.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, type GetProgramAccountsFilter } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  STOCKS_PROGRAM_ID,
  accountDiscriminator,
  base58,
  decodeGovernor,
  decodeIntentRecord,
  executeTrade,
  intentPda,
  positionAuthorityPda,
  vaultAuthorityPda,
  type GovernorState,
} from "../solana/client";
import { DbcRouteBuilder, MeteoraDbcPool } from "../stocks/dbc-venue";

export const DEVNET = {
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  rpcUrl: "https://api.devnet.solana.com",
  hub: "https://quaestor-stocks.onrender.com",
  app: "https://quaestor-app.onrender.com",
  ledger: "https://quaestor-hub.onrender.com",
  usdcMint: "8HcqMLJJxoG3fAkgNk8Qm3Uv7oXhXLM8X5xE4FXZe3Cg",
  dbcProgram: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  curvePool: "Ed6znHKEWLP1CbRgcbjLU9q21omye42PR9r1dfGSiGiM",
  curveMint: "GWVTYLHS74NFkk8fBVTx9DdsPs17bxFCwmoqZhBSiLvc",
  explorer: (kind: "tx" | "address", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`,
};

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const MAX_SLIPPAGE_BPS = 500;
const MAX_REASON_CHARS = 500;
/** Rent for the IntentRecord a trade writes, which this key pays, plus the fee, with room. */
const MIN_GAS_LAMPORTS = 3_000_000;

/** What each refusal means. Facts only; what to do next is the skill's to say. */
export const REFUSALS: Record<string, string> = {
  PerTradeCapExceeded: "Larger than the owner's per-trade cap. Only the owner can raise it.",
  EpochCapExceeded: "This epoch's budget is used up. It resets at the next epoch; only the owner can raise it.",
  InsufficientVault: "The vault holds less than this. Only the owner can deposit.",
  Suspended: "The owner has suspended this governor.",
  OperatorRequired: "This key is not the governor's operator.",
  UnapprovedInstrument: "The owner has not allowed this token.",
  UnapprovedProgram: "The owner has not allowed this venue.",
  InvalidMinimumOutput: "The floor came out as zero; the amount is too small.",
  MinimumOutputNotMet: "Less than the floor reached the position; the whole trade was undone.",
  RouteOverspent: "The venue took more than the amount authorised; the whole trade was undone.",
  StockBalanceDecreased: "The route took tokens out of the position; the whole trade was undone.",
  VaultBalanceIncreased: "The vault gained tokens during the swap; the whole trade was undone.",
  VaultAuthorityChanged: "The route tried to change who can spend the vault; the whole trade was undone.",
  ExceededSlippage: "The curve moved past the floor before the swap; nothing was bought.",
  PriceGate: "The price gate does not support this quote against the observed market. Nothing was sent.",
  PriceMoved: "The price moved since the floor was approved: the fresh floor is below it. Nothing was sent.",
  NoGas: "This key pays its own fees and the record's rent, and holds too little SOL. Run faucet.",
};

export class CliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type Result = Record<string, unknown>;
const refused = (code: string, detail: string): Result => ({ ok: false, refused: code, detail, meaning: REFUSALS[code] ?? "The program refused it." });

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

const COMMON = ["key-file", "rpc", "governor"];
export const FLAGS: Record<string, string[]> = {
  help: [],
  keygen: ["key-file"],
  whoami: ["key-file", "rpc"],
  register: ["key-file", "deposit", "per-trade", "epoch-cap", "epoch"],
  faucet: ["key-file"],
  agents: ["key-file", "rpc"],
  status: COMMON,
  quote: ["usdc", "rpc", "slippage-bps"],
  buy: ["usdc", "reason", "slippage-bps", "min-out", "dry-run", ...COMMON],
  check: ["key-file", "rpc"],
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

/** A six-decimal amount (test USDC, or the curve token) typed by an agent, in base units. */
export function amountOf(flags: Record<string, string>, name: string): bigint {
  const raw = flags[name];
  if (raw === undefined || raw === "true") throw new CliError("MISSING_ARGUMENT", `--${name} is required`);
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new CliError("BAD_ARGUMENT", `--${name} must be an amount such as 1 or 0.5, with at most 6 decimals`);
  const [whole, frac = ""] = raw.split(".");
  const value = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  if (value <= 0n) throw new CliError("BAD_ARGUMENT", `--${name} must be more than zero`);
  return value;
}

export function slippageOf(flags: Record<string, string>): number {
  const bps = Number(flags["slippage-bps"] ?? "100");
  if (!Number.isInteger(bps) || bps < 1) throw new CliError("BAD_ARGUMENT", "--slippage-bps must be a whole number, at least 1");
  if (bps > MAX_SLIPPAGE_BPS) throw new CliError("SLIPPAGE_TOO_WIDE", `--slippage-bps may be at most ${MAX_SLIPPAGE_BPS}; a wider floor protects nothing`);
  return bps;
}

/** The reason is hashed into the trade the chain records; it must be present, short, and never the key. */
export function reasonOf(flags: Record<string, string>, key?: Keypair): string {
  const reason = (flags.reason ?? "").trim();
  if (!reason || reason === "true") throw new CliError("MISSING_ARGUMENT", "--reason is required: it is committed with the trade");
  if (reason.length > MAX_REASON_CHARS) throw new CliError("BAD_ARGUMENT", `--reason may be at most ${MAX_REASON_CHARS} characters`);
  if (key) {
    const secret = base58(key.secretKey);
    const bytes = JSON.stringify([...key.secretKey]).slice(1, 60);
    if (reason.includes(secret) || reason.includes(bytes)) throw new CliError("REASON_LOOKS_SECRET", "--reason contains this agent's key; it was not sent");
  }
  return reason;
}

export const fmt = (units: bigint, decimals = 6) => {
  const scale = 10n ** BigInt(decimals);
  const frac = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${units / scale}${frac ? `.${frac}` : ""}`;
};

// ------------------------------------------------------------------ settings and key

export interface Settings {
  rpcUrl: string;
  hub: string;
  app: string;
  ledger: string;
  keyFile: string;
  genesisHash: string;
}

export function settingsFrom(flags: Record<string, string>, env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    rpcUrl: flags.rpc ?? env.QUAESTOR_SOLANA_RPC_URL ?? DEVNET.rpcUrl,
    hub: (env.QUAESTOR_STOCKS_URL ?? DEVNET.hub).replace(/\/$/, ""),
    app: env.QUAESTOR_APP_URL ?? DEVNET.app,
    ledger: env.QUAESTOR_LEDGER_URL ?? DEVNET.ledger,
    keyFile: flags["key-file"] ?? env.QUAESTOR_SOLANA_KEY_FILE ?? path.join(os.homedir(), ".quaestor", "solana-operator.json"),
    genesisHash: env.QUAESTOR_SOLANA_GENESIS ?? DEVNET.genesisHash,
  };
}

export function keygen(keyFile: string, env: NodeJS.ProcessEnv = process.env): PublicKey {
  if (env.QUAESTOR_SOLANA_KEY) throw new CliError("KEY_IN_ENV", "QUAESTOR_SOLANA_KEY is set, and every command uses it; unset it to make a key file");
  if (fs.existsSync(keyFile)) throw new CliError("KEY_EXISTS", `${keyFile} already holds a key; it is not replaced. Use --key-file for a second agent.`);
  const key = Keypair.generate();
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, JSON.stringify([...key.secretKey]), { mode: 0o600, flag: "wx" });
  return key.publicKey;
}

export function loadKey(keyFile: string, env: NodeJS.ProcessEnv = process.env): Keypair {
  const raw = env.QUAESTOR_SOLANA_KEY ?? (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8") : "");
  if (!raw.trim()) throw new CliError("NO_KEY", 'no key: run "keygen" first, or set QUAESTOR_SOLANA_KEY');
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
  } catch {
    throw new CliError("BAD_KEY", "the key is not a Solana keypair (a JSON array of 64 bytes)");
  }
}

export function registerUrl(app: string, operator: string, flags: Record<string, string> = {}): string {
  const q = new URLSearchParams({ operator });
  const epochs: Record<string, string> = { hour: "3600", day: "86400", week: "604800" };
  if (flags.deposit) q.set("deposit", fmt(amountOf(flags, "deposit")));
  if (flags["per-trade"]) q.set("perTrade", fmt(amountOf(flags, "per-trade")));
  if (flags["epoch-cap"]) q.set("epochCap", fmt(amountOf(flags, "epoch-cap")));
  if (flags["per-trade"] && flags["epoch-cap"] && amountOf(flags, "per-trade") > amountOf(flags, "epoch-cap")) {
    throw new CliError("BAD_ARGUMENT", "--per-trade is larger than --epoch-cap");
  }
  if (flags.epoch) {
    if (!epochs[flags.epoch]) throw new CliError("BAD_ARGUMENT", "--epoch must be hour, day or week");
    q.set("epoch", epochs[flags.epoch]);
  }
  return `${app}/#/app/sol/register?${q.toString()}`;
}

// ------------------------------------------------------------------ chain

async function connect(settings: Settings): Promise<Connection> {
  const conn = new Connection(settings.rpcUrl, "confirmed");
  const genesis = await conn.getGenesisHash();
  if (genesis !== settings.genesisHash) throw new CliError("WRONG_CLUSTER", `the RPC serves cluster ${genesis}, not Solana devnet`);
  return conn;
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

interface GovernorAt extends GovernorState { address: PublicKey }

/** Every governor whose operator is this key. Anyone can name any key, so each comes with its owner. */
async function governorsOf(conn: Connection, operator: PublicKey): Promise<GovernorAt[]> {
  const filters: GetProgramAccountsFilter[] = [
    { dataSize: 179 },
    { memcmp: { offset: 0, bytes: base58(accountDiscriminator("Governor")) } },
    { memcmp: { offset: 40, bytes: operator.toBase58() } },
  ];
  const accounts = await conn.getProgramAccounts(STOCKS_PROGRAM_ID, { commitment: "confirmed", filters });
  return accounts.map(({ pubkey, account }) => ({ address: pubkey, ...decodeGovernor(account.data) }));
}

async function governorFor(conn: Connection, operator: PublicKey, settings: Settings, chosen?: string): Promise<GovernorAt> {
  const mine = await governorsOf(conn, operator);
  if (chosen) {
    const g = mine.find((x) => x.address.toBase58() === chosen);
    if (!g) throw new CliError("OperatorRequired", `no governor ${chosen} names this key as operator`);
    return g;
  }
  if (!mine.length) throw new CliError("NO_GOVERNOR", `no governor names this key yet; send the owner the register link: ${registerUrl(settings.app, operator.toBase58())}`);
  if (mine.length > 1) throw new CliError("SEVERAL_GOVERNORS", `${mine.length} governors name this key; pass --governor with one of: ${mine.map((g) => g.address.toBase58()).join(", ")}`);
  return mine[0];
}

const liveEpoch = (g: GovernorState) => {
  const epoch = BigInt(Math.floor(Date.now() / 1000)) / (g.epochLength > 0n ? g.epochLength : 1n);
  return { epoch, spent: epoch === g.currentEpoch ? g.spentInEpoch : 0n };
};

async function tokenBalance(conn: Connection, account: PublicKey): Promise<bigint | null> {
  return conn.getTokenAccountBalance(account, "confirmed").then((b) => BigInt(b.value.amount)).catch(() => null);
}

/** A refusal named in a failed simulation's or transaction's logs. */
export function refusalFromLogs(logs: string[] | null | undefined): { code: string; detail: string } | null {
  const text = (logs ?? []).join("\n");
  const match = /Error Code: (\w+)\. Error Number: \d+\. Error Message: ([^\n]+)/.exec(text) ?? /Error Code: (\w+)/.exec(text);
  if (!match) return null;
  return { code: match[1], detail: match[2] ? `${match[1]}: ${match[2].trim()}` : match[1] };
}

// ------------------------------------------------------------------ hashing the decision

const keccakHex = (text: string) => `0x${Buffer.from(keccak_256(new TextEncoder().encode(text))).toString("hex")}`;
const hexBytes = (hex: string) => Buffer.from(hex.replace(/^0x/, ""), "hex");

/** The record the trade commits to, and the two hashes the program stores: the hub's own scheme. */
export function commitDecision(record: Record<string, unknown>, intent: { intentId: string; governor: string; instrumentMint: string; amountIn: bigint; minOutput: bigint }) {
  const decisionRecordHash = keccakHex(JSON.stringify(record));
  const decisionHash = keccakHex(JSON.stringify({
    intentId: intent.intentId,
    governor: intent.governor,
    instrumentMint: intent.instrumentMint,
    amountInUsdc: intent.amountIn.toString(),
    minOutput: intent.minOutput.toString(),
    decisionRecordHash,
  }));
  return { decisionRecordHash, decisionHash };
}

// ------------------------------------------------------------------ the gate

async function gateVerdict(settings: Settings, usdcIn: bigint, tokensOut: bigint, minOut: bigint): Promise<Result> {
  let res: Response;
  try {
    res = await fetch(`${settings.hub}/v1/stocks/quote-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instrument_mint: DEVNET.curveMint, usdc_in: usdcIn.toString(), tokens_out: tokensOut.toString(), min_tokens_out: minOut.toString(), venue: "meteora-dbc" }),
      signal: AbortSignal.timeout(75_000), // a free instance may be waking
    });
  } catch (err) {
    throw new CliError("GATE_UNAVAILABLE", `the price gate at ${settings.hub} did not answer (${(err as Error).message}); nothing was sent`);
  }
  if (!res.ok) throw new CliError("GATE_UNAVAILABLE", `the price gate answered ${res.status}; nothing was sent`);
  return (await res.json()) as Result;
}

// ------------------------------------------------------------------ pending buys

interface PendingBuy {
  signature: string;
  raw: string;
  lastValidBlockHeight: number;
  intentId: string;
  governor: string;
  record: Record<string, unknown>;
  decisionRecordHash: string;
  sentAt: string;
}

const pendingPath = (s: Settings) => path.join(path.dirname(s.keyFile), "solana-pending.json");
const readPending = (s: Settings): PendingBuy | null => (fs.existsSync(pendingPath(s)) ? JSON.parse(fs.readFileSync(pendingPath(s), "utf8")) : null);
function writePending(s: Settings, p: PendingBuy): void {
  fs.mkdirSync(path.dirname(pendingPath(s)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pendingPath(s), JSON.stringify(p, null, 2), { mode: 0o600 });
  const dir = path.join(path.dirname(s.keyFile), "solana-records");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${p.signature}.json`), JSON.stringify({ signature: p.signature, decisionRecordHash: p.decisionRecordHash, record: p.record }, null, 2));
}
const clearPending = (s: Settings) => fs.rmSync(pendingPath(s), { force: true });

/** Hand the record to the ledger, so the explorer can open and re-hash it; it is keccak256-addressed there too. */
async function publishRecord(s: Settings, record: Record<string, unknown>): Promise<string | undefined> {
  try {
    const res = await fetch(`${s.ledger}/decisions`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(record), signal: AbortSignal.timeout(20_000) });
    return res.ok ? undefined : `the ledger answered ${res.status}`;
  } catch (err) {
    return `the ledger did not answer: ${(err as Error).message}`;
  }
}

/** What a sent buy did: settled (with what arrived), refused in the block, never landing, or not known yet. */
async function settle(conn: Connection, s: Settings, p: PendingBuy): Promise<Result> {
  const status = (await conn.getSignatureStatuses([p.signature], { searchTransactionHistory: true })).value[0];
  const tx = DEVNET.explorer("tx", p.signature);
  if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
    clearPending(s);
    if (status.err) {
      const detail = await conn.getTransaction(p.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const refusal = refusalFromLogs(detail?.meta?.logMessages);
      return { ...refused(refusal?.code ?? "Reverted", refusal?.detail ?? JSON.stringify(status.err)), tx };
    }
    const [record] = intentPda(new PublicKey(p.governor), hexBytes(p.intentId));
    const info = await conn.getAccountInfo(record, "confirmed");
    const intent = info ? decodeIntentRecord(info.data) : null;
    const skipped = await publishRecord(s, p.record);
    return {
      ok: true,
      settled: "buy",
      tx,
      spentUsdc: intent ? fmt(intent.amountSpent) : undefined,
      received: intent ? fmt(intent.actualOutput) : undefined,
      floor: intent ? fmt(intent.minOutput) : undefined,
      intentRecord: DEVNET.explorer("address", record.toBase58()),
      // Where anyone can open the trade and hash its record against the chain.
      tradePage: `${s.app}/#/app/sol/trades/${record.toBase58()}`,
      decisionRecordHash: p.decisionRecordHash,
      recordSkipped: skipped,
    };
  }
  const height = await conn.getBlockHeight("confirmed");
  if (height > p.lastValidBlockHeight) {
    clearPending(s);
    return { ok: true, settled: false, dropped: true, tx, message: "This buy never landed and its blockhash has expired, so it never will. Nothing was spent. A new buy may be sent." };
  }
  await conn.sendRawTransaction(Buffer.from(p.raw, "base64"), { skipPreflight: true }).catch(() => undefined);
  return { ok: false, error: "UNCONFIRMED", tx, message: "Not confirmed yet; the same signed buy was sent again, which cannot spend twice. Run check again in a few seconds." };
}

// ------------------------------------------------------------------ commands

async function status(conn: Connection, s: Settings, key: Keypair | null, chosen?: string): Promise<Result> {
  if (!key && !chosen) throw new CliError("NO_KEY", 'no key: run "keygen" first, or pass --governor');
  // A named governor is read as it is, whoever this key operates: status only reads.
  const g = chosen ? await (async () => {
    let address: PublicKey;
    try { address = new PublicKey(chosen); } catch { throw new CliError("BAD_ARGUMENT", "--governor must be a Solana address"); }
    const info = await conn.getAccountInfo(address, "confirmed");
    if (!info || !info.owner.equals(STOCKS_PROGRAM_ID) || info.data.length !== 179) throw new CliError("NO_GOVERNOR", `no governor at ${chosen}`);
    return { address, ...decodeGovernor(info.data) };
  })() : await governorFor(conn, key!.publicKey, s);
  const [positionAuthority] = positionAuthorityPda(g.address, new PublicKey(DEVNET.curveMint));
  const position = associatedTokenAddress(positionAuthority, new PublicKey(DEVNET.curveMint));
  const [vault, held, gas] = await Promise.all([
    tokenBalance(conn, g.vault),
    tokenBalance(conn, position),
    key ? conn.getBalance(key.publicKey, "confirmed") : Promise.resolve(null),
  ]);
  const { epoch, spent } = liveEpoch(g);
  return {
    ok: true,
    governor: g.address.toBase58(),
    owner: g.owner.toBase58(),
    operator: g.operator.toBase58(),
    thisKeyIsOperator: key ? g.operator.equals(key.publicKey) : undefined,
    suspended: g.suspended,
    vaultUsdc: vault === null ? null : fmt(vault),
    perTradeCapUsdc: fmt(g.perTradeCap),
    epochCapUsdc: fmt(g.epochCap),
    spentThisEpochUsdc: fmt(spent),
    remainingThisEpochUsdc: fmt(g.epochCap > spent ? g.epochCap - spent : 0n),
    epoch: Number(epoch),
    epochSeconds: Number(g.epochLength),
    holdings: { qAAPLdemo: held === null ? "0" : fmt(held) },
    gasSol: gas === null ? undefined : gas / LAMPORTS_PER_SOL,
    pendingBuy: readPending(s) ? "an earlier buy is unsettled: run check" : undefined,
    page: `${s.app}/#/app/sol/agents/${g.address.toBase58()}`,
  };
}

async function quote(conn: Connection, s: Settings, usdcIn: bigint, slippageBps: number): Promise<Result> {
  const pool = new MeteoraDbcPool(conn, { pool: DEVNET.curvePool, baseMint: DEVNET.curveMint, quoteMint: DEVNET.usdcMint });
  const q = await pool.quoteBuy(usdcIn, slippageBps);
  const minOut = (q.outAmount * BigInt(10_000 - slippageBps)) / 10_000n;
  const gate = await gateVerdict(s, usdcIn, q.outAmount, minOut);
  return {
    ok: true,
    venue: "meteora-dbc",
    usdcIn: fmt(usdcIn),
    qAAPLdemoOut: fmt(q.outAmount),
    floor: fmt(minOut),
    curvePriceUsd: Number(q.priceUsd.toFixed(4)),
    curveProgress: Number(q.progress.toFixed(4)),
    gate: { allowed: gate.allowed, refusal: gate.refusal, premiumBps: gate.premium_bps, deviationBps: (gate.quote as Result | undefined)?.deviation_bps, session: gate.session },
  };
}

async function buy(conn: Connection, s: Settings, key: Keypair, flags: Record<string, string>): Promise<Result> {
  const usdcIn = amountOf(flags, "usdc");
  const slippageBps = slippageOf(flags);
  const reason = reasonOf(flags, key);
  const g = await governorFor(conn, key.publicKey, s, flags.governor);
  if (g.suspended) return refused("Suspended", `governor ${g.address.toBase58()} is suspended`);

  const curveMint = new PublicKey(DEVNET.curveMint);
  const pool = new MeteoraDbcPool(conn, { pool: DEVNET.curvePool, baseMint: DEVNET.curveMint, quoteMint: DEVNET.usdcMint });
  const q = await pool.quoteBuy(usdcIn, slippageBps);
  let minOut = (q.outAmount * BigInt(10_000 - slippageBps)) / 10_000n;
  const summary: Result = { governor: g.address.toBase58(), usdcIn: fmt(usdcIn), qAAPLdemoQuoted: fmt(q.outAmount), floor: fmt(minOut) };
  if (flags["min-out"] !== undefined) {
    const pinned = amountOf(flags, "min-out");
    if (minOut < pinned) return { ...refused("PriceMoved", `the fresh floor is ${fmt(minOut)}, below the approved ${fmt(pinned)}`), ...summary };
    minOut = minOut > pinned ? minOut : pinned;
    summary.floor = fmt(minOut);
  }
  if (minOut <= 0n) return { ...refused("InvalidMinimumOutput", "the floor came out as zero"), ...summary };

  const gate = await gateVerdict(s, usdcIn, q.outAmount, minOut);
  const gateSummary = { allowed: gate.allowed, premiumBps: gate.premium_bps, deviationBps: (gate.quote as Result | undefined)?.deviation_bps, evidenceHash: gate.evidence_hash, session: gate.session };
  summary.gate = gateSummary;
  if (gate.allowed !== true) {
    const r = (gate.refusal ?? {}) as { code?: string; message?: string };
    return { ...refused("PriceGate", `${r.code ?? "REFUSED"}: ${r.message ?? "the gate did not allow this quote"}`), ...summary };
  }

  const intentId = `0x${randomBytes(32).toString("hex")}`;
  const record: Record<string, unknown> = {
    agent: `agent-${key.publicKey.toBase58().slice(0, 8)}`,
    governor: g.address.toBase58(),
    action: "buy",
    rationale: reason,
    inputs: { venue: "meteora-dbc", pool: DEVNET.curvePool, instrument: DEVNET.curveMint, usdcIn: usdcIn.toString(), quotedOut: q.outAmount.toString(), minOut: minOut.toString(), slippageBps, gate: gateSummary },
    timestamp: new Date().toISOString(),
  };
  const { decisionRecordHash, decisionHash } = commitDecision(record, { intentId, governor: g.address.toBase58(), instrumentMint: DEVNET.curveMint, amountIn: usdcIn, minOutput: minOut });
  summary.decisionRecordHash = decisionRecordHash;

  const [vaultAuthority] = vaultAuthorityPda(g.address);
  const [positionAuthority] = positionAuthorityPda(g.address, curveMint);
  const stockAccount = associatedTokenAddress(positionAuthority, curveMint);
  const route = await new DbcRouteBuilder({ pool, vaultAuthority, vault: g.vault, stockAccount }).build({
    intent: { instrumentMint: DEVNET.curveMint } as never,
    amountIn: usdcIn,
    minOutput: minOut,
  } as never);
  const instruction = executeTrade({
    operator: key.publicKey,
    payer: key.publicKey,
    governorOwner: g.owner,
    vault: g.vault,
    instrumentMint: curveMint,
    stockAccount,
    routerProgram: route.programId,
    intentId: hexBytes(intentId),
    decisionHash: hexBytes(decisionHash),
    decisionRecordHash: hexBytes(decisionRecordHash),
    amountIn: usdcIn,
    minOutput: minOut,
    swapData: route.data,
    remaining: route.accounts,
  });
  const latest = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: key.publicKey, ...latest }).add(instruction);
  tx.sign(key);

  // Ask the chain first: a refusal costs nothing and comes back in words.
  const sim = await conn.simulateTransaction(tx);
  // A key that has never held SOL has no account, so the chain cannot even
  // simulate its transaction: that is a missing fee, not a refusal.
  if (sim.value.err === "AccountNotFound") return { ...refused("NoGas", "this key holds no SOL yet, so it has no account on devnet"), ...summary };
  if (sim.value.err) {
    const refusal = refusalFromLogs(sim.value.logs);
    return { ...refused(refusal?.code ?? "Refused", refusal?.detail ?? JSON.stringify(sim.value.err)), ...summary };
  }
  const gas = await conn.getBalance(key.publicKey, "confirmed");
  if (gas < MIN_GAS_LAMPORTS) return { ...refused("NoGas", `this key holds ${gas / LAMPORTS_PER_SOL} SOL`), ...summary };
  if (flags["dry-run"] === "true") return { ok: true, dryRun: true, wouldSettle: true, ...summary };

  const raw = tx.serialize();
  const signature = base58(tx.signature!);
  const pending: PendingBuy = { signature, raw: raw.toString("base64"), lastValidBlockHeight: latest.lastValidBlockHeight, intentId, governor: g.address.toBase58(), record, decisionRecordHash, sentAt: new Date().toISOString() };
  writePending(s, pending);
  try {
    await conn.sendRawTransaction(raw, { skipPreflight: true });
  } catch (err) {
    const known = (await conn.getSignatureStatuses([signature])).value[0];
    if (!known) return { ok: false, error: "UNCONFIRMED", tx: DEVNET.explorer("tx", signature), message: `the node did not take it (${(err as Error).message.slice(0, 100)}); run check before anything else`, ...summary };
  }
  await conn.confirmTransaction({ signature, ...latest }, "confirmed").catch(() => undefined);
  return { ...(await settle(conn, s, pending)), ...summary };
}

// ------------------------------------------------------------------ entry

const HELP = `quaestor-sol: trade tokenized stocks on a Solana devnet governor of your own

  keygen                                 make this agent's key (never printed)
  whoami                                 this key's address, SOL, and the owner's register link
  register [--deposit 50] [--per-trade 5] [--epoch-cap 25] [--epoch day]
                                         the link the owner opens and signs
  faucet                                 devnet SOL (and test USDC) for this key's fees
  agents                                 governors that name this key as operator, with owners
  status [--governor <address>]          caps, this epoch's spend, vault, holdings, gas
  quote --usdc <amount>                  the Meteora curve's quote and the price gate's verdict
  buy --usdc <amount> --reason "<why>" [--slippage-bps 100] [--min-out <tokens>] [--dry-run]
  check                                  settle a buy that was sent but not confirmed

  --key-file <path>   this agent's key (default ~/.quaestor/solana-operator.json)
  --rpc <url>         a Solana devnet RPC (default ${DEVNET.rpcUrl}, or QUAESTOR_SOLANA_RPC_URL)`;

export async function run(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; out: Result | string }> {
  try {
    const { command, flags } = parseArgs(argv);
    if (command === "--help") return { code: 0, out: HELP };
    checkFlags(command, flags);
    const s = settingsFrom(flags, env);
    switch (command) {
      case "help":
        return { code: 0, out: HELP };
      case "keygen": {
        const address = keygen(s.keyFile, env).toBase58();
        return { code: 0, out: { ok: true, operator: address, keyFile: s.keyFile, registerUrl: registerUrl(s.app, address), next: "Agree a deposit and caps with the user, run register for the link they sign, and run faucet for this key's fees. Never share the key file." } };
      }
      case "register": {
        const key = loadKey(s.keyFile, env);
        return { code: 0, out: { ok: true, operator: key.publicKey.toBase58(), registerUrl: registerUrl(s.app, key.publicKey.toBase58(), flags), next: "Send the owner this link. They connect their own Solana wallet, check the numbers and that the page shows this key, and sign once." } };
      }
      case "faucet": {
        const key = loadKey(s.keyFile, env);
        const res = await fetch(`${s.hub}/v1/stocks/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: key.publicKey.toBase58() }), signal: AbortSignal.timeout(75_000) });
        const body = (await res.json().catch(() => ({}))) as Result;
        return res.ok ? { code: 0, out: { ok: true, ...body } } : { code: 1, out: { ok: false, error: (body.error as Result | undefined)?.code ?? "FAUCET_FAILED", message: (body.error as Result | undefined)?.message ?? `the faucet answered ${res.status}` } };
      }
      case "whoami": {
        const key = loadKey(s.keyFile, env);
        const conn = await connect(s);
        return { code: 0, out: { ok: true, operator: key.publicKey.toBase58(), gasSol: (await conn.getBalance(key.publicKey)) / LAMPORTS_PER_SOL, registerUrl: registerUrl(s.app, key.publicKey.toBase58()) } };
      }
      case "agents": {
        const key = loadKey(s.keyFile, env);
        const conn = await connect(s);
        const mine = await governorsOf(conn, key.publicKey);
        return { code: 0, out: { ok: true, operator: key.publicKey.toBase58(), governors: mine.map((g) => ({ governor: g.address.toBase58(), owner: g.owner.toBase58(), suspended: g.suspended })), note: mine.length ? "Anyone can name this key as operator. Trade only for a governor whose owner is your user's wallet." : `No governor names this key yet. Send the owner: ${registerUrl(s.app, key.publicKey.toBase58())}` } };
      }
      case "status": {
        const conn = await connect(s);
        let key: Keypair | null = null;
        try { key = loadKey(s.keyFile, env); } catch { key = null; }
        return { code: 0, out: await status(conn, s, key, flags.governor) };
      }
      case "quote": {
        const conn = await connect(s);
        return { code: 0, out: await quote(conn, s, amountOf(flags, "usdc"), slippageOf(flags)) };
      }
      case "buy": {
        amountOf(flags, "usdc");
        slippageOf(flags);
        reasonOf(flags);
        const key = loadKey(s.keyFile, env);
        if (readPending(s)) return { code: 1, out: { ok: false, error: "PENDING_SPEND", message: 'an earlier buy has not been settled. Run "check" before any new buy; do not repeat it.' } };
        const conn = await connect(s);
        const out = await buy(conn, s, key, flags);
        return { code: out.ok ? 0 : out.refused ? 2 : 1, out };
      }
      case "check": {
        loadKey(s.keyFile, env);
        const pending = readPending(s);
        if (!pending) return { code: 0, out: { ok: true, pending: false, message: "No unsettled buy. A new one may be sent." } };
        const out = await settle(await connect(s), s, pending);
        return { code: out.ok ? 0 : out.refused ? 2 : 1, out };
      }
      default:
        throw new CliError("UNKNOWN_COMMAND", `unknown command "${command}"; run "help"`);
    }
  } catch (err) {
    if (err instanceof CliError) {
      if (REFUSALS[err.code] || err.code === "OperatorRequired") return { code: 2, out: refused(err.code, err.message) };
      return { code: 1, out: { ok: false, error: err.code, message: err.message } };
    }
    const message = ((err as Error).message ?? String(err)).slice(0, 300);
    if (/cannot fill|graduated/i.test(message)) return { code: 2, out: refused("NoRoute", message) };
    return { code: 1, out: { ok: false, error: "FAILED", message } };
  }
}

const invoked = process.argv[1] ?? "";
if (/quaestor-sol\.(ts|mjs|js)$/.test(invoked)) {
  void run(process.argv.slice(2)).then(({ code, out }) => {
    process.stdout.write(typeof out === "string" ? `${out}\n` : `${JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
    process.exitCode = code;
  });
}
