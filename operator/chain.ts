/**
 * The Operator's hands on-chain: the payout governor's calls, each simulated from the operator's
 * own address before it is signed, so a refusal comes back as the contract's own reason and costs
 * nothing; and Circle's CCTP fee quotes and transfer tracking for payouts to other chains.
 *
 * Who signs is a `Sender`: a key held here, or a Circle developer-controlled wallet.
 */
import { ethers } from "ethers";

export const PAYOUT_GOVERNOR_ABI = [
  "function owner() view returns (address)",
  "function operator() view returns (address)",
  "function token() view returns (address)",
  "function suspended() view returns (bool)",
  "function perDealCap() view returns (uint128)",
  "function epochCap() view returns (uint128)",
  "function newPayeeCap() view returns (uint128)",
  "function newPayeesPerEpoch() view returns (uint32)",
  "function epochLength() view returns (uint64)",
  "function currentEpoch() view returns (uint64)",
  "function paidInEpoch() view returns (uint128)",
  "function payeesAddedInEpoch() view returns (uint32)",
  "function committed() view returns (uint256)",
  "function freeBalance() view returns (uint256)",
  "function tokenMessenger() view returns (address)",
  "function maxForwardFeeBps() view returns (uint16)",
  "function routes(address) view returns (uint32 domain, bytes32 recipient)",
  "function routeNonces(address) view returns (uint256)",
  "function domainSeparator() view returns (bytes32)",
  "function payeeOf(address) view returns ((bool allowed, bool vetted, bool blocked, uint128 cap, uint64 epoch, uint128 paidInEpoch))",
  "function dealOf(bytes32) view returns ((address payee, uint8 state, bool ownerApproved, uint64 expiresAt, uint128 amount, uint128 released, bytes32 termsHash))",
  "function addPayee(address payee, bytes32 decisionHash)",
  "function openDeal(bytes32 dealId, address payee, uint128 amount, uint64 expiresAt, bytes32 termsHash, bytes32 decisionHash)",
  "function release(bytes32 dealId, uint128 amount, bytes32 proofHash, bytes32 decisionHash)",
  "function releaseCrossChain(bytes32 dealId, uint128 amount, uint256 maxFee, bytes32 proofHash, bytes32 decisionHash)",
  "function cancelDeal(bytes32 dealId, bytes32 decisionHash)",
  "function setRoute(address payee, uint32 domain, bytes32 recipient, uint256 deadline, bytes signature)",
  "function approveDeal(bytes32 dealId)",
  "function setPayee(address payee, bool allowed, bool vetted, uint128 cap)",
  "event DealOpened(bytes32 indexed dealId, address indexed payee, uint128 amount, uint64 expiresAt, bytes32 termsHash, bool pending, bytes32 decisionHash)",
  "event DealApproved(bytes32 indexed dealId, uint128 amount)",
  "event Released(bytes32 indexed dealId, address indexed payee, uint128 amount, bytes32 proofHash, bytes32 decisionHash, uint64 epoch, uint128 paidInEpoch)",
  "event ReleasedCrossChain(bytes32 indexed dealId, address indexed payee, uint128 amount, uint256 maxFee, uint32 domain, bytes32 recipient, bytes32 proofHash, bytes32 decisionHash)",
  "error NotOwner()", "error NotOperator()", "error Suspended()", "error InvalidPolicy()", "error InvalidPayee(address)",
  "error PayeeNotAllowed(address)", "error PayeeBlocked(address)", "error NewPayeeLimitReached(uint32)", "error InvalidAmount()",
  "error InvalidDeadline(uint64)", "error DealExists(bytes32)", "error DealNotPending(bytes32)", "error DealNotOpen(bytes32)",
  "error DealExpired(bytes32,uint64)", "error OverDeal(uint256,uint256)", "error InsufficientFreeBalance(uint256,uint256)",
  "error EpochCapExceeded(uint256,uint256)", "error PayeeCapExceeded(address,uint256,uint256)", "error ProofAlreadyUsed(bytes32)",
  "error MissingProof()", "error TransferMismatch(uint256,uint256,uint256)", "error CrossChainDisabled()", "error NoRoute(address)",
  "error BadSignature()", "error SignatureExpired(uint256)", "error FeeTooHigh(uint256,uint256)", "error AllowanceLeftBehind(uint256)",
] as const;

export const PAYOUTS_FACTORY_ABI = [
  "function createGovernor((address operator, address token, uint64 epochLength, uint128 perDealCap, uint128 epochCap, uint128 newPayeeCap, uint32 newPayeesPerEpoch, address[] payees, uint128[] payeeCaps, address tokenMessenger, uint16 maxForwardFeeBps, uint256 deposit) s) payable returns (address)",
  "function governorsOf(address) view returns (address[])",
  "function governorsForOperator(address) view returns (address[])",
  "event GovernorCreated(address indexed governor, address indexed owner, address indexed operator, address token, uint256 deposit)",
] as const;

export const DEAL_STATE = ["none", "pending", "open", "closed", "cancelled"] as const;

/** Signs and sends a call; returns the mined transaction's hash, or throws. */
export interface Sender {
  readonly address: string;
  send(to: string, data: string, gasLimit: bigint): Promise<string>;
}

/** Arc drops a transaction whose max fee is under 20 gwei; elsewhere the floor is just the base fee. */
const ARC_CHAINS = new Set([5042n, 5042002n]);
const ARC_MIN_FEE = ethers.parseUnits("20", "gwei");

export class KeySender implements Sender {
  constructor(private readonly wallet: ethers.Wallet) {}

  get address(): string {
    return this.wallet.address;
  }

  async send(to: string, data: string, gasLimit: bigint): Promise<string> {
    const provider = this.wallet.provider!;
    const [{ chainId }, block, fee] = await Promise.all([provider.getNetwork(), provider.getBlock("latest"), provider.getFeeData()]);
    const tip = fee.maxPriorityFeePerGas ?? 0n;
    let maxFeePerGas = ((block?.baseFeePerGas ?? 0n) * 12n) / 10n + tip;
    if (ARC_CHAINS.has(chainId) && maxFeePerGas < ARC_MIN_FEE) maxFeePerGas = ARC_MIN_FEE;
    const tx = await this.wallet.sendTransaction({ to, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas: tip > maxFeePerGas ? maxFeePerGas : tip });
    const receipt = await tx.wait(1, 120_000);
    if (!receipt || receipt.status !== 1) throw new Error(`transaction ${tx.hash} failed on chain`);
    return tx.hash;
  }
}

/** A call the governor refused, with its own error and arguments. */
export class Refused extends Error {
  constructor(readonly code: string, readonly args: readonly unknown[]) {
    super(`${code}(${args.map(String).join(", ")})`);
  }
}

const iface = new ethers.Interface(PAYOUT_GOVERNOR_ABI as unknown as string[]);

function refusalOf(err: unknown): Refused | null {
  const e = err as { data?: string; info?: { error?: { data?: string } }; error?: { data?: string } };
  const data = e.data ?? e.info?.error?.data ?? e.error?.data;
  if (typeof data !== "string" || data.length < 10) return null;
  try {
    const parsed = iface.parseError(data);
    return parsed ? new Refused(parsed.name, [...parsed.args]) : null;
  } catch {
    return null;
  }
}

export interface Limits {
  perDealCap: bigint;
  epochCap: bigint;
  newPayeeCap: bigint;
  newPayeesPerEpoch: number;
  epochLength: number;
  paidInEpoch: bigint;
  payeesAddedInEpoch: number;
  freeBalance: bigint;
  committed: bigint;
  suspended: boolean;
  maxForwardFeeBps: number;
  crossChain: boolean;
}

export class GovernorClient {
  readonly contract: ethers.Contract;

  constructor(readonly address: string, readonly provider: ethers.Provider, readonly sender: Sender) {
    this.contract = new ethers.Contract(address, PAYOUT_GOVERNOR_ABI as unknown as string[], provider);
  }

  async limits(): Promise<Limits> {
    const c = this.contract;
    const [perDealCap, epochCap, newPayeeCap, newPayeesPerEpoch, epochLength, currentEpoch, paidInEpoch, payeesAdded, freeBalance, committed, suspended, bps, messenger] = await Promise.all([
      c.perDealCap(), c.epochCap(), c.newPayeeCap(), c.newPayeesPerEpoch(), c.epochLength(), c.currentEpoch(), c.paidInEpoch(),
      c.payeesAddedInEpoch(), c.freeBalance(), c.committed(), c.suspended(), c.maxForwardFeeBps(), c.tokenMessenger(),
    ]);
    // The period's counters reset lazily on-chain; read them as the next call would see them.
    const nowEpoch = BigInt(Math.floor(Date.now() / 1000)) / BigInt(epochLength);
    const stale = nowEpoch !== BigInt(currentEpoch);
    return {
      perDealCap, epochCap, newPayeeCap, newPayeesPerEpoch: Number(newPayeesPerEpoch), epochLength: Number(epochLength),
      paidInEpoch: stale ? 0n : paidInEpoch, payeesAddedInEpoch: stale ? 0 : Number(payeesAdded), freeBalance, committed, suspended,
      maxForwardFeeBps: Number(bps), crossChain: messenger !== ethers.ZeroAddress,
    };
  }

  async payee(address: string): Promise<{ allowed: boolean; vetted: boolean; blocked: boolean; cap: bigint }> {
    const p = await this.contract.payeeOf(address);
    return { allowed: p.allowed, vetted: p.vetted, blocked: p.blocked, cap: p.cap };
  }

  async route(address: string): Promise<{ domain: number; recipient: string } | null> {
    const r = await this.contract.routes(address);
    return r.recipient === ethers.ZeroHash ? null : { domain: Number(r.domain), recipient: r.recipient };
  }

  async deal(dealId: string): Promise<{ payee: string; state: (typeof DEAL_STATE)[number]; ownerApproved: boolean; expiresAt: number; amount: bigint; released: bigint }> {
    const d = await this.contract.dealOf(dealId);
    return { payee: d.payee, state: DEAL_STATE[Number(d.state)], ownerApproved: d.ownerApproved, expiresAt: Number(d.expiresAt), amount: d.amount, released: d.released };
  }

  /** Simulate from the operator, then send; a refusal is thrown as `Refused`, before any gas. */
  private async call(fn: string, args: readonly unknown[]): Promise<string> {
    const data = iface.encodeFunctionData(fn, args);
    let gas: bigint;
    try {
      gas = await this.provider.estimateGas({ from: this.sender.address, to: this.address, data });
    } catch (err) {
      throw refusalOf(err) ?? err;
    }
    return this.sender.send(this.address, data, (gas * 13n) / 10n);
  }

  addPayee(payee: string, decisionHash: string) {
    return this.call("addPayee", [payee, decisionHash]);
  }

  openDeal(dealId: string, payee: string, amount: bigint, expiresAt: number, termsHash: string, decisionHash: string) {
    return this.call("openDeal", [dealId, payee, amount, expiresAt, termsHash, decisionHash]);
  }

  release(dealId: string, amount: bigint, proofHash: string, decisionHash: string) {
    return this.call("release", [dealId, amount, proofHash, decisionHash]);
  }

  releaseCrossChain(dealId: string, amount: bigint, maxFee: bigint, proofHash: string, decisionHash: string) {
    return this.call("releaseCrossChain", [dealId, amount, maxFee, proofHash, decisionHash]);
  }

  cancelDeal(dealId: string, decisionHash: string) {
    return this.call("cancelDeal", [dealId, decisionHash]);
  }

  /** Submit a route the payee signed; anyone may, and the operator pays the gas for them. */
  setRoute(payee: string, domain: number, recipient: string, deadline: number, signature: string) {
    return this.call("setRoute", [payee, domain, recipient, deadline, signature]);
  }
}

// ------------------------------------------------------------------ CCTP

/** CCTP domains of the chains a payee can be paid on from Arc. */
export const CCTP_DOMAINS: Record<string, { domain: number; name: string; testnet: string; explorerTx: (h: string) => string }> = {
  arc: { domain: 26, name: "Arc", testnet: "Arc testnet", explorerTx: (h) => `https://explorer.testnet.arc.io/tx/${h}` },
  base: { domain: 6, name: "Base", testnet: "Base Sepolia", explorerTx: (h) => `https://sepolia.basescan.org/tx/${h}` },
  arbitrum: { domain: 3, name: "Arbitrum", testnet: "Arbitrum Sepolia", explorerTx: (h) => `https://sepolia.arbiscan.io/tx/${h}` },
  ethereum: { domain: 0, name: "Ethereum", testnet: "Ethereum Sepolia", explorerTx: (h) => `https://sepolia.etherscan.io/tx/${h}` },
  optimism: { domain: 2, name: "OP", testnet: "OP Sepolia", explorerTx: (h) => `https://sepolia-optimism.etherscan.io/tx/${h}` },
  polygon: { domain: 7, name: "Polygon", testnet: "Polygon Amoy", explorerTx: (h) => `https://amoy.polygonscan.com/tx/${h}` },
};

export const ARC_DOMAIN = 26;

/** Circle's quote for a Standard transfer with forwarding: the most the burn should allow as fee. */
export async function forwardFee(iris: string, destinationDomain: number, amount: bigint): Promise<bigint> {
  const res = await fetch(`${iris}/v2/burn/USDC/fees/${ARC_DOMAIN}/${destinationDomain}?forward=true`);
  if (!res.ok) throw new Error(`Circle's fee quote answered ${res.status}`);
  const quotes = (await res.json()) as { finalityThreshold: number; minimumFee: number; forwardFee: { high: number } }[];
  const q = quotes.find((x) => x.finalityThreshold === 2000) ?? quotes[0];
  return BigInt(q.forwardFee.high) + (amount * BigInt(Math.ceil(q.minimumFee))) / 10_000n;
}

/** Where a burn stands: attested, and the forwarder's mint on the destination once it is done. */
export async function forwardStatus(iris: string, burnTx: string): Promise<{ status: string; forwardTxHash?: string }> {
  const res = await fetch(`${iris}/v2/messages/${ARC_DOMAIN}?transactionHash=${burnTx}`);
  if (!res.ok) return { status: `iris ${res.status}` };
  const m = ((await res.json()) as { messages?: { status: string; forwardTxHash?: string }[] }).messages?.[0];
  return { status: m?.status ?? "not seen yet", forwardTxHash: m?.forwardTxHash };
}
