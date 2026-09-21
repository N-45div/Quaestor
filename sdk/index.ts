import { ethers } from "ethers";
import * as fs from "node:fs";
import * as path from "node:path";

export * from "./stocks";
export { credentialIn } from "./record-guard";
import { credentialIn } from "./record-guard";

/** Spend categories mirror the on-chain enum. */
export enum Category {
  DATA = 0,
  INFERENCE = 1,
  EXECUTION = 2,
}

export const QUAESTOR_ABI = [
  "function registerAgent(address operator, uint32 epochLength, string metadataURI, (uint128 epochCap, uint128 perCallCap) dataPolicy, (uint128 epochCap, uint128 perCallCap) inferencePolicy, (uint128 epochCap, uint128 perCallCap) executionPolicy) payable returns (uint256)",
  "function deposit(uint256 agentId) payable",
  "function withdraw(uint256 agentId, uint256 amount, address to)",
  "function pay(uint256 agentId, uint8 category, address payee, uint256 amount, bytes32 metaHash)",
  "function swap(uint256 agentId, uint256 amountIn, uint256 minOut, address tokenOut, bytes32 metaHash) returns (uint256)",
  "function suspend(uint256 agentId)",
  "function resume(uint256 agentId)",
  "function setPolicy(uint256 agentId, uint8 category, (uint128 epochCap, uint128 perCallCap) policy)",
  "function agents(uint256) view returns (address owner, address operator, bool suspended, uint40 registeredAt, uint32 epochLength, string metadataURI)",
  "function balanceOf(uint256) view returns (uint256)",
  "function policyOf(uint256 agentId, uint8 category) view returns ((uint128 epochCap, uint128 perCallCap))",
  "function remainingBudget(uint256 agentId, uint8 category) view returns (uint256)",
  "function currentEpoch(uint256 agentId) view returns (uint256)",
  "function spentIn(uint256 agentId, uint8 category, uint256 epoch) view returns (uint256)",
  "function setGuardian(uint256 agentId, address guardian)",
  "function guardianOf(uint256) view returns (address)",
  "event Receipt(uint256 indexed agentId, uint8 indexed category, address payee, uint256 amount, bytes32 metaHash, uint256 epoch, uint256 epochSpentAfter)",
  "event SwapExecuted(uint256 indexed agentId, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
  "event Suspended(uint256 indexed agentId, address by)",
  "event Resumed(uint256 indexed agentId)",
  // Custom errors — required for parseError to decode governor refusals
  "error UnknownAgent()",
  "error NotOwner()",
  "error NotOwnerOrGuardian()",
  "error NotOperator()",
  "error AgentIsSuspended()",
  "error InvalidCategory()",
  "error ZeroAmount()",
  "error ZeroAddress()",
  "error PerCallCapExceeded(uint256 amount, uint256 cap)",
  "error EpochCapExceeded(uint256 wouldBeSpent, uint256 cap)",
  "error InsufficientTreasury(uint256 amount, uint256 balance)",
  "error TransferFailed()",
  "error Reentrancy()",
];

/**
 * QuaestorV2: a venue allowed, never trusted. Generated from the compiled
 * contract, not typed by hand: a wrong `indexed` here decodes silently wrong.
 *
 * Its `Receipt` has the same signature string as V1's, so the same topic, but
 * V2 indexes the payee. A V2 receipt read with the V1 ABI reads its payee out
 * of the wrong place, so every reader must know which governor it is reading.
 */
export const QUAESTOR_V2_ABI = [
  "error AgentIsSuspended()",
  "error EpochCapExceeded(uint256 spent, uint256 cap)",
  "error InstrumentNotAllowed(address token)",
  "error InsufficientTreasury(uint256 amount, uint256 balance)",
  "error InvalidEpochLength()",
  "error MinimumOutputNotMet(uint256 received, uint256 minimum)",
  "error NotGuardianOrOwner()",
  "error NotOperator()",
  "error NotOwner()",
  "error PerCallCapExceeded(uint256 amount, uint256 cap)",
  "error Reentrancy()",
  "error RouteOverspent(uint256 spent, uint256 authorized)",
  "error UnknownAgent()",
  "error VenueCallFailed(bytes reason)",
  "error VenueNotAllowed(address venue)",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "event AgentRegistered(uint256 indexed agentId, address indexed owner, address indexed operator, uint32 epochLength, string metadataURI)",
  "event Deposited(uint256 indexed agentId, address indexed from, uint256 amount)",
  "event GuardianChanged(uint256 indexed agentId, address indexed guardian)",
  "event InstrumentAllowed(uint256 indexed agentId, address indexed token, bool allowed)",
  "event OperatorChanged(uint256 indexed agentId, address indexed operator)",
  "event PolicySet(uint256 indexed agentId, uint8 indexed category, uint128 epochCap, uint128 perCallCap)",
  "event Receipt(uint256 indexed agentId, uint8 indexed category, address indexed payee, uint256 amount, bytes32 metaHash, uint256 epoch, uint256 epochSpentAfter)",
  "event Resumed(uint256 indexed agentId)",
  "event Suspended(uint256 indexed agentId, address indexed by)",
  "event SwapExecuted(uint256 indexed agentId, address indexed venue, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
  "event VenueAllowed(uint256 indexed agentId, address indexed venue, bool allowed)",
  "event Withdrawn(uint256 indexed agentId, address indexed to, uint256 amount)",
  "function agents(uint256) view returns (address owner, address operator, bool suspended, uint40 registeredAt, uint32 epochLength, string metadataURI)",
  "function balanceOf(uint256) view returns (uint256)",
  "function currentEpoch(uint256 agentId) view returns (uint256)",
  "function deposit(uint256 agentId) payable",
  "function guardianOf(uint256) view returns (address)",
  "function instrumentAllowed(uint256, address) view returns (bool)",
  "function nextAgentId() view returns (uint256)",
  "function pay(uint256 agentId, uint8 category, address payee, uint256 amount, bytes32 metaHash)",
  "function policyOf(uint256 agentId, uint8 category) view returns (uint128 epochCap, uint128 perCallCap)",
  "function registerAgent(address operator, uint32 epochLength, string metadataURI) payable returns (uint256 agentId)",
  "function remainingBudget(uint256 agentId, uint8 category) view returns (uint256)",
  "function resume(uint256 agentId)",
  "function setGuardian(uint256 agentId, address guardian)",
  "function setInstrument(uint256 agentId, address token, bool allowed)",
  "function setOperator(uint256 agentId, address operator)",
  "function setPolicy(uint256 agentId, uint8 category, uint128 epochCap, uint128 perCallCap)",
  "function setVenue(uint256 agentId, address venue, bool allowed)",
  "function spentIn(uint256, uint8, uint256) view returns (uint256)",
  "function suspend(uint256 agentId)",
  "function swap(uint256 agentId, address venue, bytes swapData, address tokenOut, uint256 amountIn, uint256 minOut, bytes32 metaHash) returns (uint256 amountOut)",
  "function venueAllowed(uint256, address) view returns (bool)",
  "function withdraw(uint256 agentId, uint256 amount, address to)",
];

/** QuaestorLog: decision records and threat reports as event data. */
export const QUAESTOR_LOG_ABI = [
  "error EmptyRecord()",
  "error FieldTooLarge(uint256 size, uint256 max)",
  "error RecordTooLarge(uint256 size, uint256 max)",
  "event Published(bytes32 indexed metaHash, address indexed publisher, bytes record)",
  "event Reported(bytes32 indexed venueHash, bytes32 indexed humanId, address indexed reporter, string venue, string pattern, bytes32 tenantHash)",
  "function MAX_FIELD_BYTES() view returns (uint256)",
  "function MAX_RECORD_BYTES() view returns (uint256)",
  "function publish(bytes record) returns (bytes32 metaHash)",
  "function report(string venue, string pattern, bytes32 humanId, bytes32 tenantHash)",
];

/** Which governor a reader is talking to. The two do not decode each other's events. */
export type GovernorVersion = 1 | 2;

export function governorAbi(version: GovernorVersion): string[] {
  return version === 2 ? QUAESTOR_V2_ABI : QUAESTOR_ABI;
}

/** `GOVERNOR_VERSION` from the environment: 2 means QuaestorV2, anything else the original. */
export function governorVersionFromEnv(value = process.env.GOVERNOR_VERSION): GovernorVersion {
  return value === "2" ? 2 : 1;
}

export const DEX_ABI = [
  "function getNativeToTokenOut(address token, uint256 amountIn) view returns (uint256)",
  "function getTokenToNativeOut(address token, uint256 amountIn) view returns (uint256)",
  "function spotPrice(address token) view returns (uint256)",
  "function pools(address) view returns (uint256 reserveNative, uint256 reserveToken, uint256 totalShares)",
  "function swapExactNativeForTokens(uint256 minOut, address tokenOut, address to) payable returns (uint256)",
  "function addLiquidity(address token, uint256 maxAmountToken) payable returns (uint256)",
];

/**
 * The decision record behind a spend. The keccak256 of its canonical JSON is
 * committed on-chain in the Receipt; the JSON itself is persisted locally so
 * any receipt can be audited against what the agent was actually thinking.
 */
export interface DecisionMeta {
  agent: string;
  action: string;
  rationale: string;
  inputs?: Record<string, unknown>;
  model?: string;
  timestamp: string;
}

export function metaHashOf(meta: DecisionMeta): string {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(meta)));
}

export interface QuaestorConfig {
  rpcUrl: string;
  /**
   * Per-request RPC timeout. ethers' default is 300 s, which on a public
   * testnet RPC that occasionally stalls means a single stuck call holds a
   * spend — and whoever is waiting on it — for five minutes. 20 s fails fast
   * enough to retry and long enough for an honest slow block.
   */
  rpcTimeoutMs?: number;
  /** How long `pay`/`swap` wait for the receipt before giving up (default 90 s). */
  waitTimeoutMs?: number;
  quaestorAddress: string;
  dexAddress?: string;
  /** Operator (or owner) private key. Not needed when `signer` is given. */
  privateKey?: string;
  /**
   * A signer that is already connected to a provider: a test chain's account,
   * or a key held somewhere this process cannot read it. Takes the place of
   * `rpcUrl` and `privateKey`.
   */
  signer?: ethers.Signer;
  /** Directory where decision records are persisted. Default: ./runs/receipts */
  receiptDir?: string;
  /**
   * Optional decision-record ledger. When set, every committed decision JSON
   * is also published there, so third parties can open a Receipt's metaHash
   * and verify it against the chain themselves.
   */
  decisionLedgerUrl?: string;
  /** Which governor this is. Defaults to the original; QuaestorV2 swaps through any allowed venue. */
  governorVersion?: GovernorVersion;
  /**
   * QuaestorLog. When set, every decision record behind a spend that settled is
   * also published there, as event data, so it outlives any host. The operator
   * pays for it, a fraction of a cent on an L2.
   */
  logAddress?: string;
}

/** What a settled spend left behind. `recordTx` is absent if the record was not published on chain. */
export interface SpendResult {
  txHash: string;
  metaHash: string;
  recordTx?: string;
  /** Why the record was not published on chain, when it was not. */
  recordSkipped?: string;
}

/** Operator-side client: everything a governed agent may do. */
export class QuaestorAgent {
  readonly provider: ethers.Provider;
  readonly signer: ethers.NonceManager;
  readonly quaestor: ethers.Contract;
  readonly dex?: ethers.Contract;
  readonly receiptDir: string;
  readonly version: GovernorVersion;
  readonly log?: ethers.Contract;

  constructor(private readonly cfg: QuaestorConfig) {
    // NonceManager: back-to-back pay→swap in one cycle would otherwise race
    // the provider's cached transaction count and reuse a nonce.
    if (cfg.signer) {
      if (!cfg.signer.provider) throw new Error("the signer must be connected to a provider");
      this.provider = cfg.signer.provider;
      this.signer = new ethers.NonceManager(cfg.signer);
    } else {
      if (!cfg.privateKey) throw new Error("a privateKey or a connected signer is required");
      const req = new ethers.FetchRequest(cfg.rpcUrl);
      req.timeout = cfg.rpcTimeoutMs ?? 20_000;
      this.provider = new ethers.JsonRpcProvider(req);
      this.signer = new ethers.NonceManager(new ethers.Wallet(cfg.privateKey, this.provider));
    }
    this.version = cfg.governorVersion ?? 1;
    this.quaestor = new ethers.Contract(cfg.quaestorAddress, governorAbi(this.version), this.signer);
    this.log = cfg.logAddress ? new ethers.Contract(cfg.logAddress, QUAESTOR_LOG_ABI, this.signer) : undefined;
    this.dex = cfg.dexAddress
      ? new ethers.Contract(cfg.dexAddress, DEX_ABI, this.signer)
      : undefined;
    this.receiptDir = cfg.receiptDir ?? path.join(process.cwd(), "runs", "receipts");
    fs.mkdirSync(this.receiptDir, { recursive: true });
  }

  /** Pay a service (DATA or INFERENCE) with a committed decision record. */
  /**
   * Send through the NonceManager and, if the chain says our nonce is stale,
   * reset the manager and retry once.
   *
   * The manager fetches its base nonce on first use and only ever increments
   * from there. Any other process signing with the same key — a deploy's old
   * instance still draining its last request — leaves that base behind, and
   * without a reset every later send fails with "nonce has already been used"
   * until the process restarts. That is what silenced the heartbeat after a
   * redeploy.
   */
  private async withFreshNonce<T>(send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (err) {
      const msg = ((err as Error).message ?? "").toLowerCase();
      const code = (err as { code?: string }).code;
      if (code === "NONCE_EXPIRED" || /nonce (has already been used|too low)/.test(msg)) {
        this.signer.reset();
        return await send();
      }
      throw err;
    }
  }

  /** The agent's treasury balance — what the caps are enforced against. */
  async treasury(agentId: bigint): Promise<bigint> {
    return this.quaestor.balanceOf(agentId);
  }

  async pay(
    agentId: bigint,
    category: Category.DATA | Category.INFERENCE,
    payee: string,
    amountWei: bigint,
    meta: DecisionMeta
  ): Promise<SpendResult> {
    const metaHash = metaHashOf(meta);
    const tx = await this.withFreshNonce(() =>
      this.quaestor.pay(agentId, category, payee, amountWei, metaHash)
    );
    // Publish to the ledger before waiting. The record is bound by its hash,
    // not by the receipt, so nothing about it depends on the block arriving —
    // and a wait that times out on a lagging RPC must not leave a mined spend
    // with no explanation behind it.
    this.persistMeta(tx.hash, meta, metaHash);
    const rcpt = await tx.wait(1, this.cfg.waitTimeoutMs ?? 90_000);
    return { txHash: rcpt.hash, metaHash, ...(await this.publishOnChain(meta, metaHash)) };
  }

  /** Execute a governed swap on the original governor, through its fixed router. */
  async swap(
    agentId: bigint,
    amountInWei: bigint,
    minOut: bigint,
    tokenOut: string,
    meta: DecisionMeta
  ): Promise<SpendResult> {
    if (this.version === 2) {
      throw new Error("QuaestorV2 has no fixed router: use swapThrough with a venue and its calldata");
    }
    const metaHash = metaHashOf(meta);
    const tx = await this.withFreshNonce(() =>
      this.quaestor.swap(agentId, amountInWei, minOut, tokenOut, metaHash)
    );
    this.persistMeta(tx.hash, meta, metaHash);
    const rcpt = await tx.wait(1, this.cfg.waitTimeoutMs ?? 90_000);
    return { txHash: rcpt.hash, metaHash, ...(await this.publishOnChain(meta, metaHash)) };
  }

  /**
   * Execute a governed swap on QuaestorV2, through a venue the owner allowed.
   *
   * `swapData` is the venue's own calldata and the governor never reads it.
   * What bounds the trade is measured by the contract: what left the treasury
   * and what reached the owner, so calldata that pays anyone else reverts.
   */
  async swapThrough(
    agentId: bigint,
    venue: string,
    swapData: string,
    tokenOut: string,
    amountInWei: bigint,
    minOut: bigint,
    meta: DecisionMeta
  ): Promise<SpendResult & { amountOut?: bigint }> {
    if (this.version !== 2) {
      throw new Error("swapThrough needs QuaestorV2; the original governor swaps through its fixed router");
    }
    const metaHash = metaHashOf(meta);
    const tx = await this.withFreshNonce(() =>
      this.quaestor.swap(agentId, venue, swapData, tokenOut, amountInWei, minOut, metaHash)
    );
    this.persistMeta(tx.hash, meta, metaHash);
    const rcpt = await tx.wait(1, this.cfg.waitTimeoutMs ?? 90_000);
    // What arrived, from the transaction's own event. A read made after the
    // send can be answered from an earlier block and report nothing moved.
    const executed = rcpt.logs
      .map((log: ethers.Log) => { try { return this.quaestor.interface.parseLog(log); } catch { return null; } })
      .find((parsed: ethers.LogDescription | null) => parsed?.name === "SwapExecuted");
    return {
      txHash: rcpt.hash,
      metaHash,
      amountOut: executed ? (executed.args.amountOut as bigint) : undefined,
      ...(await this.publishOnChain(meta, metaHash)),
    };
  }

  async remainingBudget(agentId: bigint, category: Category): Promise<bigint> {
    return this.quaestor.remainingBudget(agentId, category);
  }

  async isSuspended(agentId: bigint): Promise<boolean> {
    const info = await this.quaestor.agents(agentId);
    return info.suspended;
  }

  /**
   * Put the record behind a settled spend on chain, as event data.
   *
   * Only after the spend has settled: a refused spend has no Receipt pointing
   * at it, and paying to publish its record would buy nothing. A record that
   * looks like it carries a credential is never published, because a
   * published record cannot be taken back. Failure here never undoes or
   * reports the spend as failed: the spend happened, and the record is still
   * in the ledger and on disk.
   */
  private async publishOnChain(meta: DecisionMeta, metaHash: string): Promise<{ recordTx?: string; recordSkipped?: string }> {
    if (!this.log) return {};
    const text = JSON.stringify(meta);
    const leaked = credentialIn(text);
    if (leaked) return { recordSkipped: `not published: it looks like it contains ${leaked}` };
    const bytes = ethers.toUtf8Bytes(text);
    // The same bytes whose hash the Receipt carries, checked rather than assumed.
    if (ethers.keccak256(bytes) !== metaHash) return { recordSkipped: "not published: the record does not hash to the committed metaHash" };
    try {
      const tx = await this.withFreshNonce(() => this.log!.publish(bytes));
      const rcpt = await tx.wait(1, this.cfg.waitTimeoutMs ?? 90_000);
      return { recordTx: rcpt.hash };
    } catch (err) {
      return { recordSkipped: `publish failed: ${((err as Error).message ?? String(err)).slice(0, 120)}` };
    }
  }

  private persistMeta(txHash: string, meta: DecisionMeta, metaHash: string) {
    const file = path.join(this.receiptDir, `${txHash}.json`);
    fs.writeFileSync(file, JSON.stringify({ txHash, metaHash, meta }, null, 2));
    void this.publishMeta(meta);
  }

  /** Publish the EXACT hashed string to the ledger; failures never block spends. */
  private async publishMeta(meta: DecisionMeta): Promise<void> {
    if (!this.cfg.decisionLedgerUrl) return;
    try {
      await fetch(`${this.cfg.decisionLedgerUrl}/decisions`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(meta),
      });
    } catch (err) {
      console.error("[sdk] ledger publish failed:", (err as Error).message);
    }
  }
}

/**
 * Decode a Quaestor custom error out of an ethers exception, if present.
 * Returns e.g. "EpochCapExceeded(0.0105, 0.01)" or null when not ours.
 */
/**
 * Every error either governor or the log can raise, once each. An error with
 * the same name and argument types in both governors has the same selector,
 * so it is listed once; the V1-only ones are added after.
 */
const ALL_ERRORS = (() => {
  const seen = new Map<string, string>();
  for (const line of [...QUAESTOR_V2_ABI, ...QUAESTOR_ABI, ...QUAESTOR_LOG_ABI]) {
    if (!line.startsWith("error ")) continue;
    const fragment = ethers.ErrorFragment.from(line);
    if (!seen.has(fragment.selector)) seen.set(fragment.selector, line);
  }
  return [...seen.values()];
})();

export function decodeQuaestorError(err: unknown): string | null {
  const e = err as any;
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (typeof data !== "string") return null;
  try {
    const iface = new ethers.Interface(ALL_ERRORS);
    const parsed = iface.parseError(data);
    if (!parsed) return null;
    const args = parsed.args
      .map((a) => (typeof a === "bigint" ? ethers.formatEther(a) : String(a)))
      .join(", ");
    return `${parsed.name}(${args})`;
  } catch {
    return null;
  }
}

export interface ReceiptCheck {
  /** Address that must have been paid. */
  payee: string;
  /** Minimum amount, in wei. */
  minAmountWei: bigint;
  /** Only accept receipts at most this many blocks old. Default 500. */
  maxAgeBlocks?: number;
  /** Which governor wrote the receipt. V2 indexes the payee, so the two decode differently. */
  version?: GovernorVersion;
}

/**
 * Service-side verification: given a tx hash presented by a caller, confirm it
 * contains a Quaestor Receipt paying `payee` at least `minAmountWei`.
 * This is how a paid API accepts on-chain settlement instead of API keys.
 */
export async function verifyReceipt(
  provider: ethers.Provider,
  quaestorAddress: string,
  txHash: string,
  check: ReceiptCheck
): Promise<{ ok: boolean; reason?: string; agentId?: bigint; amount?: bigint }> {
  const rcpt = await provider.getTransactionReceipt(txHash);
  if (!rcpt) return { ok: false, reason: "transaction not found" };
  if (rcpt.status !== 1) return { ok: false, reason: "transaction reverted" };

  const maxAge = check.maxAgeBlocks ?? 500;
  const head = await provider.getBlockNumber();
  if (head - rcpt.blockNumber > maxAge) return { ok: false, reason: "receipt too old" };

  const iface = new ethers.Interface(governorAbi(check.version ?? 1));
  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() !== quaestorAddress.toLowerCase()) continue;
    let parsed;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (parsed?.name !== "Receipt") continue;
    const payee = (parsed.args.payee as string).toLowerCase();
    const amount = parsed.args.amount as bigint;
    if (payee === check.payee.toLowerCase() && amount >= check.minAmountWei) {
      return { ok: true, agentId: parsed.args.agentId as bigint, amount };
    }
  }
  return { ok: false, reason: "no matching Receipt in transaction" };
}

// ---------------------------------------------------------------------------
// The cross-chain budget root (contracts/attested/QuaestorAttested.sol)
// ---------------------------------------------------------------------------

/** keccak256("Receipt(uint256,uint8,address,uint256,bytes32,uint256,uint256)") */
export const RECEIPT_TOPIC = ethers.id("Receipt(uint256,uint8,address,uint256,bytes32,uint256,uint256)");
/** keccak256("Suspended(uint256,address)") */
export const SUSPENDED_TOPIC = ethers.id("Suspended(uint256,address)");

export const ATTESTED_ABI = [
  "function owner() view returns (address)",
  "function registerSource(uint64 chainKey, address emitter)",
  "function linkAgent(uint256 groupId, address emitter, uint256 agentId)",
  "function setGlobalCap(uint256 groupId, uint256 cap, uint32 epochLength)",
  "function clearBreach(uint256 groupId)",
  "function execute(uint8 action, uint64 chainKey, uint64 blockHeight, bytes encodedTransaction, bytes32 merkleRoot, (bytes32 hash, bool isLeft)[] siblings, bytes32 lowerEndpointDigest, bytes32[] continuityRoots) returns (bool)",
  "function executeBatch(uint8 action, (uint64 chainKey, uint64[] heights, bytes[] encodedTransactions, bytes32[] merkleRoots, (bytes32 hash, bool isLeft)[][] siblings, bytes32 lowerEndpointDigest, bytes32[] continuityRoots) b) returns (bool)",
  "function groups(uint256) view returns (uint256 cap, uint32 epochLength, uint40 since, bool breached, uint256 epochIndex, uint256 spentInEpoch, uint256 attestedSpends)",
  "function globalSpent(uint256 groupId) view returns (uint256)",
  "function globalRemaining(uint256 groupId) view returns (uint256)",
  "function isBreached(uint256 groupId) view returns (bool)",
  "function currentEpoch(uint256 groupId) view returns (uint256)",
  "function chainKeyOf(address emitter) view returns (uint64)",
  "function groupOf(bytes32 agentKey) view returns (uint256)",
  "function suspensionsOf(bytes32 agentKey) view returns (uint256)",
  "function processedQueries(bytes32 queryId) view returns (bool)",
  "event SourceRegistered(uint64 indexed chainKey, address indexed emitter)",
  "event AgentLinked(uint256 indexed groupId, address indexed emitter, uint256 indexed agentId)",
  "event GlobalCapSet(uint256 indexed groupId, uint256 cap, uint32 epochLength)",
  "event SpendAttested(uint256 indexed groupId, address indexed emitter, uint256 indexed agentId, uint8 category, uint256 amount, bytes32 metaHash, bytes32 queryId, uint256 spentInEpoch)",
  "event GlobalCapBreached(uint256 indexed groupId, uint256 spentInEpoch, uint256 cap)",
  "event BreachCleared(uint256 indexed groupId, address by)",
  "event SuspensionAttested(address indexed emitter, uint256 indexed agentId, address by, bytes32 queryId, uint256 total)",
];

/** keccak256(abi.encodePacked(emitter, agentId)) — the root's per-agent key. */
export function agentKeyOf(emitter: string, agentId: bigint | number): string {
  return ethers.solidityPackedKeccak256(["address", "uint256"], [emitter, agentId]);
}
export * from "./solana-pay";
