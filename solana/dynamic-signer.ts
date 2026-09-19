/**
 * The operator's key as a Dynamic MPC wallet.
 *
 * A hosted hub that holds the operator's keypair holds the whole key: whoever
 * reads that host's environment can sign as the operator until the owner
 * rotates the operator on chain. Held as a two-of-two MPC wallet instead, the
 * key is never whole anywhere. This process has one share, Dynamic has the
 * other, a signature takes both, and the owner can end the host's ability to
 * sign by revoking one API token, without touching the chain.
 *
 * It changes who can sign, not what a signature can do. The governor's caps,
 * allowlists and balance checks bind an MPC signature exactly as they bind a
 * local one, and only the owner can withdraw either way.
 *
 * The SDK carries a native module with no Windows build, so it is loaded on
 * first use rather than at import: a machine that never turns this on never
 * loads it.
 */
import { PublicKey, type Transaction } from "@solana/web3.js";
import type { RemoteSigner } from "./client";

/** What `importPrivateKey` / `createWalletAccount` returned, kept as it was given. */
export interface DynamicWalletFile {
  walletMetadata: { accountAddress: string } & Record<string, unknown>;
  externalServerKeyShares?: unknown[];
}

/** The part of Dynamic's Solana client this module uses. */
export interface DynamicSvmClient {
  authenticateApiToken(token: string): Promise<unknown>;
  signTransaction(request: {
    walletMetadata: DynamicWalletFile["walletMetadata"];
    transaction: Transaction;
    externalServerKeyShares?: unknown[];
    password?: string;
    chainId: string;
  }): Promise<string | { signature: string }>;
}

export interface DynamicSignerConfig {
  environmentId: string;
  authToken: string;
  wallet: DynamicWalletFile;
  /** Decrypts the backed-up share; the one the wallet was created with. */
  password?: string;
  /** Dynamic's id for the cluster: "101" mainnet, "103" devnet. */
  chainId?: string;
  /** A co-signer that does not answer is a trade that does not happen. */
  timeoutMs?: number;
  /** The API token buys a session that expires; this is how often to renew it. */
  sessionMs?: number;
  /** Injected in tests, where there is no SDK and no network. */
  createClient?: (environmentId: string) => DynamicSvmClient | Promise<DynamicSvmClient>;
  now?: () => number;
}

const SDK = "@dynamic-labs-wallet/node-svm";

const loadSdkClient = async (environmentId: string): Promise<DynamicSvmClient> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require(SDK) as { DynamicSvmWalletClient: new (props: { environmentId: string }) => DynamicSvmClient };
  return new sdk.DynamicSvmWalletClient({ environmentId });
};

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 to bytes, as Solana prints signatures. */
export function fromBase58(text: string): Uint8Array {
  let value = 0n;
  for (const ch of text) {
    const digit = BASE58.indexOf(ch);
    if (digit < 0) throw new Error("not base58");
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  for (const ch of text) {
    if (ch !== BASE58[0]) break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

const within = async <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export class DynamicOperatorSigner implements RemoteSigner {
  readonly publicKey: PublicKey;
  private client: DynamicSvmClient | undefined;
  private authenticatedAt = 0;
  private opening: Promise<DynamicSvmClient> | undefined;

  constructor(private readonly cfg: DynamicSignerConfig) {
    this.publicKey = new PublicKey(cfg.wallet.walletMetadata.accountAddress);
  }

  private get timeoutMs(): number { return this.cfg.timeoutMs ?? 20_000; }
  private now(): number { return (this.cfg.now ?? Date.now)(); }

  /** A client with a live session. Concurrent callers share one sign-in. */
  private session(fresh = false): Promise<DynamicSvmClient> {
    const live = this.client && this.now() - this.authenticatedAt < (this.cfg.sessionMs ?? 10 * 60_000);
    if (live && !fresh) return Promise.resolve(this.client as DynamicSvmClient);
    this.opening ??= (async () => {
      try {
        const client = this.client ?? await (this.cfg.createClient ?? loadSdkClient)(this.cfg.environmentId);
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

  private async signOnce(tx: Transaction, fresh: boolean): Promise<Uint8Array> {
    const client = await this.session(fresh);
    const answer = await within(client.signTransaction({
      walletMetadata: this.cfg.wallet.walletMetadata,
      transaction: tx,
      externalServerKeyShares: this.cfg.wallet.externalServerKeyShares,
      password: this.cfg.password,
      chainId: this.cfg.chainId ?? "103",
    }), this.timeoutMs, "Dynamic signing");
    return fromBase58(typeof answer === "string" ? answer : answer.signature);
  }

  async signTransaction(tx: Transaction): Promise<Uint8Array> {
    try {
      return await this.signOnce(tx, false);
    } catch {
      // Most often a session that lapsed between trades. Asking twice is safe:
      // it is the same message, and a signature is not a submission.
      return this.signOnce(tx, true);
    }
  }
}

/**
 * The signer an environment describes, or null when it describes none.
 * Throws when it is switched on but incomplete: a hub asked to sign through
 * Dynamic must not quietly fall back to a key it happens to have.
 */
export function dynamicOperatorFromEnv(
  readWalletFile: () => string,
  env: NodeJS.ProcessEnv = process.env,
): DynamicOperatorSigner | null {
  if (env.DYNAMIC_OPERATOR !== "1") return null;
  const environmentId = env.DYNAMIC_ENVIRONMENT_ID;
  const authToken = env.DYNAMIC_AUTH_TOKEN;
  if (!environmentId || !authToken) throw new Error("DYNAMIC_OPERATOR needs DYNAMIC_ENVIRONMENT_ID and DYNAMIC_AUTH_TOKEN");
  const wallet = JSON.parse(env.DYNAMIC_OPERATOR_WALLET ?? readWalletFile()) as DynamicWalletFile;
  if (typeof wallet?.walletMetadata?.accountAddress !== "string") throw new Error("the Dynamic wallet file has no account address");
  return new DynamicOperatorSigner({
    environmentId,
    authToken,
    wallet,
    password: env.DYNAMIC_WALLET_PASSWORD,
    chainId: env.DYNAMIC_SOLANA_CHAIN_ID,
  });
}
