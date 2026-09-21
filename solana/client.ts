/**
 * A hand-built client for the Quaestor Solana programs.
 *
 * There is no IDL here on purpose. Generating one needs the Anchor CLI, which
 * is a long build for something the tests do not require: Anchor's wire format
 * is a stable convention — an eight-byte `sha256("global:<name>")` prefix in
 * front of borsh-encoded arguments — and writing it out by hand keeps the suite
 * dependent on nothing but a validator and the two `.so` files it loads.
 *
 * It runs in a browser as well as in Node, so the explorer and the agent
 * command build the very instructions the validator suite has proven: no file
 * reads, no node:crypto, and Buffer imported rather than assumed global.
 * The program ids are the ones in each program's declare_id!, and
 * test/solana-client.test.ts fails if Anchor.toml ever says otherwise.
 */
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
  type Signer,
} from "@solana/web3.js";

export const STOCKS_PROGRAM_ID = new PublicKey("7whSJDtnCjhjPiBeLWoyVYHemtG1BnyBVfuJuuNDtFEG");
export const ROUTER_STUB_PROGRAM_ID = new PublicKey("3RTVgJ1jXnUZTkaQwvgZiy98vfFqHxHr9Ey8CXyX9imS");

export const GOVERNOR_SEED = Buffer.from("governor");
export const VAULT_AUTHORITY_SEED = Buffer.from("vault");
export const INSTRUMENT_SEED = Buffer.from("instrument");
export const INTENT_SEED = Buffer.from("intent");
export const ROUTER_SEED = Buffer.from("router");
export const POSITION_SEED = Buffer.from("position");

// ----------------------------------------------------------------- encoding

/** Anchor's instruction prefix: the first eight bytes of sha256("global:name"). */
export function discriminator(name: string): Buffer {
  return Buffer.from(sha256(`global:${name}`)).subarray(0, 8);
}

/**
 * Anchor's account prefix: the first eight bytes of sha256("account:Name").
 *
 * The same eight bytes an RPC memcmp filter needs to ask for every account of
 * one type. `test/solana-ledger.test.ts` checks these against the constants the
 * lean program carries, which the validator suite has already proven on chain.
 */
export function accountDiscriminator(account: string): Buffer {
  return Buffer.from(sha256(`account:${account}`)).subarray(0, 8);
}

export const u64 = (v: bigint | number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

export const i64 = (v: bigint | number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v));
  return b;
};

export const bool = (v: boolean): Buffer => Buffer.from([v ? 1 : 0]);

/** A fixed-size `[u8; 32]` carries no length prefix; a `Vec<u8>` carries a u32. */
export const bytes32 = (v: Uint8Array): Buffer => {
  if (v.length !== 32) throw new Error(`expected 32 bytes, got ${v.length}`);
  return Buffer.from(v);
};

export const vecU8 = (v: Uint8Array): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(v.length);
  return Buffer.concat([len, Buffer.from(v)]);
};

/** The venue label is a fixed `[u8; 16]`, so it is padded, not length-prefixed. */
export const label16 = (name: string): Buffer => {
  const b = Buffer.alloc(16);
  const written = Buffer.from(name, "utf8");
  if (written.length > 16) throw new Error(`venue label "${name}" exceeds 16 bytes`);
  written.copy(b);
  return b;
};

/** A deterministic 32-byte id, so a failing run names the case that failed. */
export const id32 = (label: string): Buffer => Buffer.from(sha256(label));

// --------------------------------------------------------------------- PDAs

export const governorPda = (owner: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync([GOVERNOR_SEED, owner.toBuffer()], STOCKS_PROGRAM_ID);

export const vaultAuthorityPda = (governor: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync([VAULT_AUTHORITY_SEED, governor.toBuffer()], STOCKS_PROGRAM_ID);

export const instrumentPda = (governor: PublicKey, mint: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync(
    [INSTRUMENT_SEED, governor.toBuffer(), mint.toBuffer()],
    STOCKS_PROGRAM_ID,
  );

export const routerPda = (governor: PublicKey, program: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync(
    [ROUTER_SEED, governor.toBuffer(), program.toBuffer()],
    STOCKS_PROGRAM_ID,
  );

export const positionAuthorityPda = (governor: PublicKey, mint: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync(
    [POSITION_SEED, governor.toBuffer(), mint.toBuffer()],
    STOCKS_PROGRAM_ID,
  );

export const intentPda = (governor: PublicKey, intentId: Uint8Array): [PublicKey, number] =>
  PublicKey.findProgramAddressSync(
    [INTENT_SEED, governor.toBuffer(), Buffer.from(intentId)],
    STOCKS_PROGRAM_ID,
  );

// ------------------------------------------------------------- account meta

const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const signer = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: false });
const signerRw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: true });

// -------------------------------------------------------------- instructions

export interface InitGovernorArgs {
  owner: PublicKey;
  operator: PublicKey;
  usdcMint: PublicKey;
  vault: PublicKey;
  tokenProgram: PublicKey;
  epochCap: bigint;
  perTradeCap: bigint;
  epochLength: bigint;
}

export function initializeGovernor(a: InitGovernorArgs): TransactionInstruction {
  const [governor] = governorPda(a.owner);
  const [vaultAuthority] = vaultAuthorityPda(governor);
  return new TransactionInstruction({
    programId: STOCKS_PROGRAM_ID,
    keys: [
      signerRw(a.owner),
      rw(governor),
      ro(vaultAuthority),
      ro(a.usdcMint),
      // The vault has no seeds, so `init` creates it from a keypair the client
      // supplies; it has to sign its own creation.
      { pubkey: a.vault, isSigner: true, isWritable: true },
      ro(a.tokenProgram),
      ro(SystemProgram.programId),
      ro(SYSVAR_RENT_PUBKEY),
    ],
    data: Buffer.concat([
      discriminator("initialize_governor"),
      a.operator.toBuffer(),
      u64(a.epochCap),
      u64(a.perTradeCap),
      i64(a.epochLength),
    ]),
  });
}

/** The four owner-only setters share one accounts struct. */
function ownerOnly(owner: PublicKey, name: string, args: Buffer): TransactionInstruction {
  const [governor] = governorPda(owner);
  return new TransactionInstruction({
    programId: STOCKS_PROGRAM_ID,
    keys: [signer(owner), rw(governor)],
    data: Buffer.concat([discriminator(name), args]),
  });
}

export const setPolicy = (owner: PublicKey, epochCap: bigint, perTradeCap: bigint) =>
  ownerOnly(owner, "set_policy", Buffer.concat([u64(epochCap), u64(perTradeCap)]));

export const setOperator = (owner: PublicKey, operator: PublicKey) =>
  ownerOnly(owner, "set_operator", operator.toBuffer());

export const setSuspended = (owner: PublicKey, suspended: boolean) =>
  ownerOnly(owner, "set_suspended", bool(suspended));

/** Allow one more venue. A governor may hold several at once. */
export function approveRouter(
  owner: PublicKey,
  routerProgram: PublicKey,
  label: string,
): TransactionInstruction {
  const [governor] = governorPda(owner);
  const [approved] = routerPda(governor, routerProgram);
  return new TransactionInstruction({
    programId: STOCKS_PROGRAM_ID,
    keys: [
      signerRw(owner),
      ro(governor),
      ro(routerProgram),
      rw(approved),
      ro(SystemProgram.programId),
    ],
    data: Buffer.concat([discriminator("approve_router"), label16(label)]),
  });
}

export function revokeRouter(owner: PublicKey, routerProgram: PublicKey): TransactionInstruction {
  const [governor] = governorPda(owner);
  const [approved] = routerPda(governor, routerProgram);
  return new TransactionInstruction({
    programId: STOCKS_PROGRAM_ID,
    keys: [signerRw(owner), ro(governor), rw(approved)],
    data: discriminator("revoke_router"),
  });
}

export function approveInstrument(owner: PublicKey, mint: PublicKey): TransactionInstruction {
  const [governor] = governorPda(owner);
  const [approved] = instrumentPda(governor, mint);
  return new TransactionInstruction({
    programId: STOCKS_PROGRAM_ID,
    keys: [signerRw(owner), ro(governor), ro(mint), rw(approved), ro(SystemProgram.programId)],
    data: discriminator("approve_instrument"),
  });
}

export function revokeInstrument(owner: PublicKey, mint: PublicKey): TransactionInstruction {
  const [governor] = governorPda(owner);
  const [approved] = instrumentPda(governor, mint);
  return new TransactionInstruction({
    programId: STOCKS_PROGRAM_ID,
    keys: [signerRw(owner), ro(governor), rw(approved)],
    data: discriminator("revoke_instrument"),
  });
}

export interface DepositArgs {
  depositor: PublicKey;
  governorOwner: PublicKey;
  vault: PublicKey;
  depositorUsdc: PublicKey;
  usdcMint: PublicKey;
  tokenProgram: PublicKey;
  amount: bigint;
}

export function depositUsdc(a: DepositArgs): TransactionInstruction {
  const [governor] = governorPda(a.governorOwner);
  return new TransactionInstruction({
    programId: STOCKS_PROGRAM_ID,
    keys: [
      signer(a.depositor),
      ro(governor),
      rw(a.vault),
      rw(a.depositorUsdc),
      ro(a.usdcMint),
      ro(a.tokenProgram),
    ],
    data: Buffer.concat([discriminator("deposit_usdc"), u64(a.amount)]),
  });
}

export interface WithdrawArgs {
  owner: PublicKey;
  vault: PublicKey;
  destination: PublicKey;
  usdcMint: PublicKey;
  tokenProgram: PublicKey;
  amount: bigint;
}

export function withdrawUsdc(a: WithdrawArgs): TransactionInstruction {
  const [governor] = governorPda(a.owner);
  const [vaultAuthority] = vaultAuthorityPda(governor);
  return new TransactionInstruction({
    programId: STOCKS_PROGRAM_ID,
    keys: [
      signer(a.owner),
      rw(governor),
      ro(vaultAuthority),
      rw(a.vault),
      rw(a.destination),
      ro(a.usdcMint),
      ro(a.tokenProgram),
    ],
    data: Buffer.concat([discriminator("withdraw_usdc"), u64(a.amount)]),
  });
}

/** The stub's own `swap`, as the governor will rebuild it from remaining_accounts. */
export interface StubSwapArgs {
  vaultAuthority: PublicKey;
  poolAuthority: PublicKey;
  vault: PublicKey;
  poolInput: PublicKey;
  poolOutput: PublicKey;
  destination: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputTokenProgram: PublicKey;
  outputTokenProgram: PublicKey;
}

export function stubSwapAccounts(a: StubSwapArgs): AccountMeta[] {
  return [
    ro(a.vaultAuthority),
    signer(a.poolAuthority),
    rw(a.vault),
    rw(a.poolInput),
    rw(a.poolOutput),
    rw(a.destination),
    ro(a.inputMint),
    ro(a.outputMint),
    ro(a.inputTokenProgram),
    ro(a.outputTokenProgram),
  ];
}

export const stubSwapData = (inputTaken: bigint, outputGiven: bigint): Buffer =>
  Buffer.concat([discriminator("swap"), u64(inputTaken), u64(outputGiven)]);

/** The stub's attacking route: an honest swap plus a sweep of another position. */
export const stubSwapAndSweepData = (inputTaken: bigint, outputGiven: bigint, swept: bigint): Buffer =>
  Buffer.concat([discriminator("swap_and_sweep"), u64(inputTaken), u64(outputGiven), u64(swept)]);

export function stubSwapAndSweepAccounts(
  a: StubSwapArgs & { otherPosition: PublicKey; otherMint: PublicKey; otherPool: PublicKey },
): AccountMeta[] {
  return [...stubSwapAccounts(a), rw(a.otherPosition), ro(a.otherMint), rw(a.otherPool)];
}

/** The stub's other route: take shares back out of the destination. */
export const stubSweepData = (amount: bigint): Buffer =>
  Buffer.concat([discriminator("sweep"), u64(amount)]);

export interface ExecuteTradeArgs {
  operator: PublicKey;
  payer: PublicKey;
  governorOwner: PublicKey;
  vault: PublicKey;
  instrumentMint: PublicKey;
  stockAccount: PublicKey;
  routerProgram: PublicKey;
  intentId: Uint8Array;
  decisionHash: Uint8Array;
  decisionRecordHash: Uint8Array;
  amountIn: bigint;
  minOutput: bigint;
  swapData: Buffer;
  remaining: AccountMeta[];
  /** Override the derived instrument PDA, to test an unapproved mint. */
  approvedInstrument?: PublicKey;
  /** Override the derived venue PDA, to test an unapproved router. */
  approvedRouter?: PublicKey;
}

export function executeTrade(a: ExecuteTradeArgs): TransactionInstruction {
  const [governor] = governorPda(a.governorOwner);
  const [vaultAuthority] = vaultAuthorityPda(governor);
  const [approved] = instrumentPda(governor, a.instrumentMint);
  const [positionAuthority] = positionAuthorityPda(governor, a.instrumentMint);
  const [intentRecord] = intentPda(governor, a.intentId);
  return new TransactionInstruction({
    programId: STOCKS_PROGRAM_ID,
    keys: [
      signer(a.operator),
      signerRw(a.payer),
      rw(governor),
      ro(vaultAuthority),
      rw(a.vault),
      ro(a.instrumentMint),
      ro(a.approvedInstrument ?? approved),
      ro(positionAuthority),
      rw(a.stockAccount),
      rw(intentRecord),
      ro(a.routerProgram),
      ro(a.approvedRouter ?? routerPda(governor, a.routerProgram)[0]),
      ro(SystemProgram.programId),
      // Everything the router needs, passed through untouched. The program
      // rebuilds the instruction from these and never reads swapData.
      ...a.remaining,
    ],
    data: Buffer.concat([
      discriminator("execute_trade"),
      bytes32(a.intentId),
      bytes32(a.decisionHash),
      bytes32(a.decisionRecordHash),
      u64(a.amountIn),
      u64(a.minOutput),
      vecU8(a.swapData),
    ]),
  });
}

// ----------------------------------------------------------------- decoding

export interface GovernorState {
  owner: PublicKey;
  operator: PublicKey;
  usdcMint: PublicKey;
  vault: PublicKey;
  epochCap: bigint;
  perTradeCap: bigint;
  epochLength: bigint;
  currentEpoch: bigint;
  spentInEpoch: bigint;
  suspended: boolean;
}

export async function fetchGovernor(conn: Connection, governor: PublicKey): Promise<GovernorState> {
  const info = await conn.getAccountInfo(governor);
  if (!info) throw new Error(`governor ${governor.toBase58()} does not exist`);
  return decodeGovernor(info.data);
}

/** A Governor account's bytes, as read by getAccountInfo or a getProgramAccounts scan. */
export function decodeGovernor(data: Uint8Array): GovernorState {
  const d = Buffer.from(data);
  let o = 8;
  const key = () => new PublicKey(d.subarray(o, (o += 32)));
  const num = () => d.readBigUInt64LE(((o += 8), o - 8));
  const snum = () => d.readBigInt64LE(((o += 8), o - 8));
  return {
    owner: key(),
    operator: key(),
    usdcMint: key(),
    vault: key(),
    epochCap: num(),
    perTradeCap: num(),
    epochLength: snum(),
    currentEpoch: snum(),
    spentInEpoch: num(),
    suspended: d[o] === 1,
  };
}

export interface ApprovedRouterState {
  governor: PublicKey;
  program: PublicKey;
  label: string;
}

export async function fetchApprovedRouter(
  conn: Connection,
  approved: PublicKey,
): Promise<ApprovedRouterState | null> {
  const info = await conn.getAccountInfo(approved);
  if (!info) return null;
  const d = info.data;
  return {
    governor: new PublicKey(d.subarray(8, 40)),
    program: new PublicKey(d.subarray(40, 72)),
    label: d.subarray(72, 88).toString("utf8").replace(/\0+$/, ""),
  };
}

export interface IntentRecordState {
  governor: PublicKey;
  intentId: Buffer;
  decisionHash: Buffer;
  decisionRecordHash: Buffer;
  amountAuthorized: bigint;
  amountSpent: bigint;
  minOutput: bigint;
  actualOutput: bigint;
  epoch: bigint;
  settledAt: bigint;
}

export async function fetchIntentRecord(
  conn: Connection,
  record: PublicKey,
  /** Refuse an answer from a node that has not yet seen this slot. */
  options: { minContextSlot?: number } = {},
): Promise<IntentRecordState | null> {
  const info = await conn.getAccountInfo(record, { commitment: "confirmed", minContextSlot: options.minContextSlot });
  return info ? decodeIntentRecord(info.data) : null;
}

/** An IntentRecord account's bytes: what one settled trade left on chain. */
export function decodeIntentRecord(data: Uint8Array): IntentRecordState {
  const d = Buffer.from(data);
  let o = 8;
  const key = () => new PublicKey(d.subarray(o, (o += 32)));
  const hash = () => Buffer.from(d.subarray(o, (o += 32)));
  const num = () => d.readBigUInt64LE(((o += 8), o - 8));
  const snum = () => d.readBigInt64LE(((o += 8), o - 8));
  return {
    governor: key(),
    intentId: hash(),
    decisionHash: hash(),
    decisionRecordHash: hash(),
    amountAuthorized: num(),
    amountSpent: num(),
    minOutput: num(),
    actualOutput: num(),
    epoch: snum(),
    settledAt: snum(),
  };
}

// -------------------------------------------------------------- send/expect

/**
 * A signer whose key is not in this process: an MPC wallet, an HSM, a wallet
 * service. It is shown the transaction and answers with its 64-byte ed25519
 * signature over the message, or throws.
 */
export interface RemoteSigner {
  readonly publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Uint8Array>;
}

export type TransactionSigner = Signer | RemoteSigner;

export const isRemoteSigner = (signer: TransactionSigner): signer is RemoteSigner =>
  typeof (signer as RemoteSigner).signTransaction === "function";

export async function send(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: TransactionSigner[],
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  let blockhash: string;
  let lastValidBlockHeight: number;
  let raw: Buffer;
  try {
    ({ blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash());
    tx.recentBlockhash = blockhash;
    tx.feePayer = signers[0].publicKey;
    // Remote signers go first, so what leaves this process to be co-signed
    // carries no local signature yet: whoever sees it cannot submit it.
    for (const remote of signers.filter(isRemoteSigner)) {
      const signature = await remote.signTransaction(tx);
      if (signature.length !== 64) throw new Error("a remote signer answered with something that is not a signature");
      tx.addSignature(remote.publicKey, Buffer.from(signature));
    }
    const local = signers.filter((signer): signer is Signer => !isRemoteSigner(signer));
    // partialSign, not sign: sign() would discard the signatures added above.
    if (local.length > 0) tx.partialSign(...local);
    // serialize() checks every signature against the message, so a remote
    // signer that signed something else is caught here, before anything is sent.
    raw = tx.serialize();
  } catch (error) {
    // Nothing has left this process, so whatever went wrong, no trade happened.
    throw new NotSubmittedError(error);
  }
  // Known before it is sent: a transaction's id is its first signature. If the
  // network goes quiet from here on, this is what lets the caller find out
  // later whether it landed, instead of guessing.
  const signature = base58(tx.signature as Buffer);
  let res;
  try {
    // Preflight is skipped so a refusal arrives as a confirmed transaction with
    // logs rather than as a simulation error, which is what the assertions read.
    await conn.sendRawTransaction(raw, { skipPreflight: true });
    res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  } catch (error) {
    throw new UnresolvedSubmission(signature, lastValidBlockHeight, error);
  }
  const sig = signature;
  if (res.value.err) {
    // The revert is already confirmed. Failing to fetch its logs must not turn
    // a known outcome into an unknown one.
    let logs: string[] = [];
    try {
      const detail = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      logs = detail?.meta?.logMessages ?? [];
    } catch {
      // logs are a courtesy
    }
    throw new TxFailure(sig, res.value.err, logs);
  }
  return sig;
}

/** The transaction was never sent: a failure before anything left this process. */
export class NotSubmittedError extends Error {
  constructor(readonly cause: unknown) {
    super("transaction was not submitted");
    this.name = "NotSubmittedError";
  }
}

/**
 * The transaction may or may not have landed. It was signed and handed to the
 * network, and then the network stopped answering. The signature and the last
 * block height at which it can still be included are what a caller needs to
 * settle the question rather than assume an answer.
 */
export class UnresolvedSubmission extends Error {
  constructor(
    readonly signature: string,
    readonly lastValidBlockHeight: number,
    readonly cause: unknown,
  ) {
    super("transaction was submitted but its outcome is not yet known");
    this.name = "UnresolvedSubmission";
  }
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58, as Solana prints signatures. Small enough not to be worth a dependency. */
export function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = BASE58_ALPHABET[0] + out;
  }
  return out;
}

export class TxFailure extends Error {
  constructor(
    readonly signature: string,
    readonly err: unknown,
    readonly logs: string[],
  ) {
    super(`transaction failed: ${JSON.stringify(err)}`);
    this.name = "TxFailure";
  }

  /** Anchor prints `Error Code: <Name>.` for every `require!` it fails. */
  get anchorError(): string | null {
    for (const line of this.logs) {
      const m = /Error Code: (\w+)\./.exec(line);
      if (m) return m[1];
    }
    return null;
  }
}

/**
 * Run `fn` and require that the chain rejected it for `code`.
 *
 * A test that only asserted "this threw" would pass when the transaction failed
 * for an unrelated reason — a bad account order, a missing signature — which is
 * exactly how a refusal test quietly stops testing the refusal.
 */
export async function expectRefusal(code: string, fn: () => Promise<unknown>): Promise<TxFailure> {
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof TxFailure)) throw error;
    const actual = error.anchorError;
    if (actual !== code) {
      const tail = error.logs.slice(-6).join("\n  ");
      throw new Error(
        `expected refusal ${code}, chain gave ${actual ?? "no anchor error"}\n  ${tail}`,
      );
    }
    return error;
  }
  throw new Error(`expected refusal ${code}, but the transaction succeeded`);
}

/** For a rejection the runtime raises before Anchor ever sees the instruction. */
export async function expectFailure(match: RegExp, fn: () => Promise<unknown>): Promise<TxFailure> {
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof TxFailure)) throw error;
    if (!error.logs.some((l) => match.test(l))) {
      throw new Error(
        `expected a log matching ${match}, got:\n  ${error.logs.slice(-8).join("\n  ")}`,
      );
    }
    return error;
  }
  throw new Error(`expected failure matching ${match}, but the transaction succeeded`);
}

export async function airdrop(conn: Connection, to: PublicKey, sol = 10): Promise<void> {
  const sig = await conn.requestAirdrop(to, sol * 1_000_000_000);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
}

export const freshKeypair = (): Keypair => Keypair.generate();
