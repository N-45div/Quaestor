/**
 * An EVM agent's key as a Dynamic MPC wallet, as an ethers signer.
 *
 * The EVM counterpart of solana/dynamic-signer.ts. The key is two-of-two: the host holds one
 * share, Dynamic the other, and a signature takes both, so whoever reads the host's environment
 * still cannot sign once the owner revokes the API token. It changes who can sign, not what a
 * signature can do: the governor's caps, allowlists, limit prices and Chainlink guard bind an
 * MPC-signed trade exactly as they bind a local one, and only the owner can withdraw.
 *
 * Dynamic's EVM SDK is loaded on first use, not at import: a host that never turns this on never
 * loads it, and it needs Node 20 or later.
 */
import { ethers } from "ethers";
import { redactingLogger } from "../solana/dynamic-signer";

/** What `createWalletAccount` / `importPrivateKey` returned, kept as it was given. */
export interface DynamicEvmWalletFile {
  walletMetadata: { accountAddress: string } & Record<string, unknown>;
  externalServerKeyShares?: unknown[];
}

/** A transaction as Dynamic's SDK takes it (viem's TransactionSerializable, EIP-1559). */
export interface DynamicEvmTransaction {
  chainId: number;
  type: "eip1559";
  to?: `0x${string}`;
  data?: `0x${string}`;
  value: bigint;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** The part of Dynamic's EVM client this module uses. */
export interface DynamicEvmClient {
  authenticateApiToken(token: string): Promise<unknown>;
  signTransaction(request: { walletMetadata: DynamicEvmWalletFile["walletMetadata"]; transaction: DynamicEvmTransaction; password?: string; externalServerKeyShares?: unknown[] }): Promise<string>;
  signMessage(request: { walletMetadata: DynamicEvmWalletFile["walletMetadata"]; message: string; password?: string; externalServerKeyShares?: unknown[] }): Promise<string>;
  signTypedData(request: { walletMetadata: DynamicEvmWalletFile["walletMetadata"]; typedData: unknown; password?: string; externalServerKeyShares?: unknown[] }): Promise<string>;
}

export interface DynamicEvmSignerConfig {
  environmentId: string;
  authToken: string;
  wallet: DynamicEvmWalletFile;
  /** Decrypts the backed-up share; the one the wallet was created with. */
  password?: string;
  /** A co-signer that does not answer is a trade that does not happen. */
  timeoutMs?: number;
  /** The API token buys a session that expires; this is how often to renew it. */
  sessionMs?: number;
  /** Injected in tests, where there is no SDK and no network. */
  createClient?: (environmentId: string) => DynamicEvmClient | Promise<DynamicEvmClient>;
  now?: () => number;
}

const SDK = "@dynamic-labs-wallet/node-evm";

const loadSdkClient = async (environmentId: string): Promise<DynamicEvmClient> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require(SDK) as {
    DynamicEvmWalletClient: new (props: { environmentId: string; enableMPCAccelerator?: boolean; logger?: ReturnType<typeof redactingLogger> }) => DynamicEvmClient;
  };
  // The accelerator needs an AWS Nitro enclave; elsewhere it fails attestation.
  return new sdk.DynamicEvmWalletClient({ environmentId, enableMPCAccelerator: false, logger: redactingLogger() });
};

const within = async <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
};

const hex = (v: string | null | undefined) => (v ? (ethers.hexlify(v) as `0x${string}`) : undefined);

export class DynamicEvmSigner extends ethers.AbstractSigner {
  readonly address: string;
  private client: DynamicEvmClient | undefined;
  private authenticatedAt = 0;
  private opening: Promise<DynamicEvmClient> | undefined;

  constructor(private readonly cfg: DynamicEvmSignerConfig, provider: ethers.Provider | null = null) {
    super(provider);
    this.address = ethers.getAddress(cfg.wallet.walletMetadata.accountAddress);
  }

  private get timeoutMs(): number { return this.cfg.timeoutMs ?? 30_000; }
  private now(): number { return (this.cfg.now ?? Date.now)(); }

  getAddress(): Promise<string> {
    return Promise.resolve(this.address);
  }

  connect(provider: ethers.Provider | null): DynamicEvmSigner {
    return new DynamicEvmSigner(this.cfg, provider);
  }

  /** A client with a live session. Concurrent callers share one sign-in. */
  private session(fresh = false): Promise<DynamicEvmClient> {
    const live = this.client && this.now() - this.authenticatedAt < (this.cfg.sessionMs ?? 10 * 60_000);
    if (live && !fresh) return Promise.resolve(this.client as DynamicEvmClient);
    this.opening ??= (async () => {
      try {
        const client = this.client ?? (await (this.cfg.createClient ?? loadSdkClient)(this.cfg.environmentId));
        await within(client.authenticateApiToken(this.cfg.authToken), this.timeoutMs, "Dynamic sign-in");
        this.client = client;
        this.authenticatedAt = this.now();
        return client;
      } finally {
        this.opening = undefined;
      }
    })();
    return this.opening;
  }

  /** Load the SDK and sign in ahead of the first trade, so a bad setup shows at boot. */
  async warm(): Promise<void> {
    await this.session();
  }

  /** Sign once; a lapsed session gets one retry with a fresh sign-in. Asking twice is safe: a signature is not a submission. */
  private async withSession<T>(what: string, sign: (client: DynamicEvmClient) => Promise<T>): Promise<T> {
    try {
      return await within(sign(await this.session(false)), this.timeoutMs, what);
    } catch {
      return within(sign(await this.session(true)), this.timeoutMs, what);
    }
  }

  async signTransaction(request: ethers.TransactionRequest): Promise<string> {
    const tx = await this.populateTransaction(request);
    if (tx.type !== undefined && tx.type !== null && tx.type !== 2) throw new Error("the Dynamic signer sends EIP-1559 transactions only");
    if (tx.maxFeePerGas == null || tx.maxPriorityFeePerGas == null) throw new Error("the transaction has no EIP-1559 fees");
    const transaction: DynamicEvmTransaction = {
      chainId: Number(tx.chainId),
      type: "eip1559",
      to: tx.to ? (ethers.getAddress(tx.to as string) as `0x${string}`) : undefined,
      data: hex(tx.data),
      value: BigInt(tx.value ?? 0n),
      nonce: Number(tx.nonce),
      gas: BigInt(tx.gasLimit!),
      maxFeePerGas: BigInt(tx.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
    };
    const raw = await this.withSession("Dynamic signing", (c) => c.signTransaction({
      walletMetadata: this.cfg.wallet.walletMetadata, transaction, password: this.cfg.password, externalServerKeyShares: this.cfg.wallet.externalServerKeyShares,
    }));
    // The chain checks it anyway; checking here means a wrong share is an error, not a stuck nonce.
    const parsed = ethers.Transaction.from(raw);
    if (parsed.from?.toLowerCase() !== this.address.toLowerCase()) throw new Error("Dynamic's signature recovers to another address");
    return raw;
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    if (typeof message !== "string") throw new Error("the Dynamic signer signs text messages only");
    return this.withSession("Dynamic signing", (c) => c.signMessage({
      walletMetadata: this.cfg.wallet.walletMetadata, message, password: this.cfg.password, externalServerKeyShares: this.cfg.wallet.externalServerKeyShares,
    }));
  }

  async signTypedData(domain: ethers.TypedDataDomain, types: Record<string, ethers.TypedDataField[]>, value: Record<string, unknown>): Promise<string> {
    const primaryType = ethers.TypedDataEncoder.getPrimaryType(types);
    const typedData = { domain, types, primaryType, message: value };
    return this.withSession("Dynamic signing", (c) => c.signTypedData({
      walletMetadata: this.cfg.wallet.walletMetadata, typedData, password: this.cfg.password, externalServerKeyShares: this.cfg.wallet.externalServerKeyShares,
    }));
  }
}

/**
 * The signer an environment describes, or null when it describes none. Throws when one is named
 * but incomplete: a hub asked to sign through Dynamic must not quietly fall back to a key it has.
 */
export function dynamicEvmSignerFromEnv(walletVar: string, env: NodeJS.ProcessEnv = process.env, provider: ethers.Provider | null = null): DynamicEvmSigner | null {
  const walletJson = env[walletVar];
  if (!walletJson) return null;
  const environmentId = env.DYNAMIC_ENVIRONMENT_ID;
  const authToken = env.DYNAMIC_AUTH_TOKEN;
  if (!environmentId || !authToken) throw new Error(`${walletVar} needs DYNAMIC_ENVIRONMENT_ID and DYNAMIC_AUTH_TOKEN`);
  const wallet = JSON.parse(walletJson) as DynamicEvmWalletFile;
  if (typeof wallet?.walletMetadata?.accountAddress !== "string") throw new Error(`${walletVar} has no account address`);
  return new DynamicEvmSigner({ environmentId, authToken, wallet, password: env.DYNAMIC_WALLET_PASSWORD }, provider);
}
