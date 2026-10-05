/**
 * The operator's key, held by Circle: a developer-controlled wallet on Arc signs and sends each
 * governor call, so no private key for the operator lives on the hub. The hub holds an API key
 * and the entity secret, and every request carries the secret freshly encrypted to Circle's
 * public key (RSA-OAEP, SHA-256), as Circle requires; a ciphertext is never reused.
 *
 * Plain REST rather than Circle's SDK: the SDK's optional Solana peer dependency conflicts with
 * the one this repository pins, and these are four calls.
 */
import { constants, createPublicKey, publicEncrypt, randomUUID } from "node:crypto";
import type { ethers } from "ethers";
import type { Sender } from "./chain";

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CircleConfig {
  apiKey: string;
  /** 32 bytes, hex: registered with Circle once, in the Developer Console. */
  entitySecret: string;
  baseUrl?: string;
  fetchFn?: Fetch;
}

const TERMINAL_FAILURES = new Set(["FAILED", "DENIED", "CANCELLED"]);

export class CircleClient {
  private publicKey: string | null = null;
  private readonly base: string;
  private readonly fetchFn: Fetch;

  constructor(private readonly cfg: CircleConfig) {
    if (!/^[0-9a-fA-F]{64}$/.test(cfg.entitySecret)) throw new Error("the entity secret must be 32 bytes of hex");
    this.base = (cfg.baseUrl ?? "https://api.circle.com").replace(/\/$/, "");
    this.fetchFn = cfg.fetchFn ?? (fetch as unknown as Fetch);
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json", "x-request-id": randomUUID() },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { data?: T; code?: number; message?: string };
    if (!res.ok) throw new Error(`Circle answered ${res.status}${json.code ? ` (${json.code})` : ""}: ${json.message ?? "no message"}`);
    return json.data as T;
  }

  /** A fresh ciphertext of the entity secret, as each mutating request needs. */
  async ciphertext(): Promise<string> {
    if (!this.publicKey) this.publicKey = (await this.call<{ publicKey: string }>("GET", "/v1/w3s/config/entity/publicKey")).publicKey;
    const der = Buffer.from(this.publicKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(this.cfg.entitySecret, "hex")).toString("base64");
  }

  /** Register this entity secret with Circle, once; returns the recovery file's contents to keep offline. */
  async registerEntitySecret(): Promise<string> {
    return (await this.call<{ recoveryFile: string }>("POST", "/v1/w3s/config/entity/entitySecret", { entitySecretCiphertext: await this.ciphertext() })).recoveryFile;
  }

  /** Test USDC and gas from Circle's faucet, on a testnet. */
  async drip(address: string, blockchain: string): Promise<void> {
    await this.call("POST", "/v1/faucet/drips", { address, blockchain, native: true, usdc: true });
  }

  async wallet(id: string): Promise<{ id: string; address: string; blockchain: string; state: string }> {
    return (await this.call<{ wallet: { id: string; address: string; blockchain: string; state: string } }>("GET", `/v1/w3s/wallets/${encodeURIComponent(id)}`)).wallet;
  }

  async createWalletSet(name: string): Promise<string> {
    const out = await this.call<{ walletSet: { id: string } }>("POST", "/v1/w3s/developer/walletSets", { idempotencyKey: randomUUID(), entitySecretCiphertext: await this.ciphertext(), name });
    return out.walletSet.id;
  }

  async createWallet(walletSetId: string, blockchain: string): Promise<{ id: string; address: string }> {
    const out = await this.call<{ wallets: { id: string; address: string }[] }>("POST", "/v1/w3s/developer/wallets", {
      idempotencyKey: randomUUID(), entitySecretCiphertext: await this.ciphertext(), walletSetId, blockchains: [blockchain], count: 1, accountType: "EOA",
    });
    return out.wallets[0];
  }

  async execute(walletId: string, contractAddress: string, callData: string, gasLimit: bigint): Promise<string> {
    const out = await this.call<{ id: string; state: string }>("POST", "/v1/w3s/developer/transactions/contractExecution", {
      idempotencyKey: randomUUID(), entitySecretCiphertext: await this.ciphertext(), walletId, contractAddress, callData,
      feeLevel: "MEDIUM", gasLimit: gasLimit.toString(),
    });
    return out.id;
  }

  async transaction(id: string): Promise<{ id: string; state: string; txHash?: string; errorReason?: string }> {
    return (await this.call<{ transaction: { id: string; state: string; txHash?: string; errorReason?: string } }>("GET", `/v1/w3s/transactions/${encodeURIComponent(id)}`)).transaction;
  }
}

/** A Sender whose key is a Circle wallet: the call goes to Circle, and returns once it is mined. */
export class CircleSender implements Sender {
  constructor(
    private readonly circle: CircleClient,
    private readonly walletId: string,
    readonly address: string,
    private readonly provider: ethers.Provider,
    private readonly opts: { pollMs?: number; timeoutMs?: number } = {},
  ) {}

  /** The sender for a wallet, its address read from Circle so the two cannot disagree. */
  static async open(circle: CircleClient, walletId: string, blockchain: string, provider: ethers.Provider): Promise<CircleSender> {
    const w = await circle.wallet(walletId);
    if (w.blockchain !== blockchain) throw new Error(`Circle wallet ${walletId} is on ${w.blockchain}, not ${blockchain}`);
    return new CircleSender(circle, walletId, w.address, provider);
  }

  async send(to: string, data: string, gasLimit: bigint): Promise<string> {
    const id = await this.circle.execute(this.walletId, to, data, gasLimit);
    const pollMs = this.opts.pollMs ?? 2_000;
    const deadline = Date.now() + (this.opts.timeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      const t = await this.circle.transaction(id);
      if (TERMINAL_FAILURES.has(t.state)) throw new Error(`Circle transaction ${id} ${t.state.toLowerCase()}${t.errorReason ? `: ${t.errorReason}` : ""}`);
      if ((t.state === "CONFIRMED" || t.state === "COMPLETE") && t.txHash) {
        // Circle has seen it mined; wait until this hub's own RPC has too, since the caller reads state next.
        const receipt = await this.provider.waitForTransaction(t.txHash, 1, 60_000);
        if (!receipt || receipt.status !== 1) throw new Error(`transaction ${t.txHash} failed on chain`);
        return t.txHash;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`Circle transaction ${id} was not mined within ${Math.round((this.opts.timeoutMs ?? 180_000) / 1000)} s`);
  }
}
