import { ethers } from "ethers";
import * as fs from "node:fs";
import * as path from "node:path";

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
  quaestorAddress: string;
  dexAddress?: string;
  /** Operator (or owner) private key. */
  privateKey: string;
  /** Directory where decision records are persisted. Default: ./runs/receipts */
  receiptDir?: string;
  /**
   * Optional decision-record ledger. When set, every committed decision JSON
   * is also published there, so third parties can open a Receipt's metaHash
   * and verify it against the chain themselves.
   */
  decisionLedgerUrl?: string;
}

/** Operator-side client: everything a governed agent may do. */
export class QuaestorAgent {
  readonly provider: ethers.JsonRpcProvider;
  readonly signer: ethers.NonceManager;
  readonly quaestor: ethers.Contract;
  readonly dex?: ethers.Contract;
  readonly receiptDir: string;

  constructor(private readonly cfg: QuaestorConfig) {
    this.provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
    // NonceManager: back-to-back pay→swap in one cycle would otherwise race
    // the provider's cached transaction count and reuse a nonce.
    this.signer = new ethers.NonceManager(
      new ethers.Wallet(cfg.privateKey, this.provider)
    );
    this.quaestor = new ethers.Contract(cfg.quaestorAddress, QUAESTOR_ABI, this.signer);
    this.dex = cfg.dexAddress
      ? new ethers.Contract(cfg.dexAddress, DEX_ABI, this.signer)
      : undefined;
    this.receiptDir = cfg.receiptDir ?? path.join(process.cwd(), "runs", "receipts");
    fs.mkdirSync(this.receiptDir, { recursive: true });
  }

  /** Pay a service (DATA or INFERENCE) with a committed decision record. */
  async pay(
    agentId: bigint,
    category: Category.DATA | Category.INFERENCE,
    payee: string,
    amountWei: bigint,
    meta: DecisionMeta
  ): Promise<{ txHash: string; metaHash: string }> {
    const metaHash = metaHashOf(meta);
    const tx = await this.quaestor.pay(agentId, category, payee, amountWei, metaHash);
    const rcpt = await tx.wait();
    this.persistMeta(rcpt.hash, meta, metaHash);
    return { txHash: rcpt.hash, metaHash };
  }

  /** Execute a governed swap with a committed decision record. */
  async swap(
    agentId: bigint,
    amountInWei: bigint,
    minOut: bigint,
    tokenOut: string,
    meta: DecisionMeta
  ): Promise<{ txHash: string; metaHash: string }> {
    const metaHash = metaHashOf(meta);
    const tx = await this.quaestor.swap(agentId, amountInWei, minOut, tokenOut, metaHash);
    const rcpt = await tx.wait();
    this.persistMeta(rcpt.hash, meta, metaHash);
    return { txHash: rcpt.hash, metaHash };
  }

  async remainingBudget(agentId: bigint, category: Category): Promise<bigint> {
    return this.quaestor.remainingBudget(agentId, category);
  }

  async isSuspended(agentId: bigint): Promise<boolean> {
    const info = await this.quaestor.agents(agentId);
    return info.suspended;
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
export function decodeQuaestorError(err: unknown): string | null {
  const e = err as any;
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (typeof data !== "string") return null;
  try {
    const iface = new ethers.Interface(QUAESTOR_ABI);
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

  const iface = new ethers.Interface(QUAESTOR_ABI);
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
