import express, { type Express } from "express";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { rateLimit } from "./hardening";

/**
 * Test USDC and a little SOL for someone opening a governor on devnet.
 *
 * Every governor here is funded in one test USDC mint, because the Meteora
 * curve is priced in it and a governor's mint is fixed when it is created.
 * Only the deployer can mint it, and the deployer key never goes on a host.
 * So a separate faucet key holds a supply minted to it once, off the host,
 * and this hands out a small amount per wallet per day. It is devnet money
 * either way; the limits keep one visitor from emptying it for the next.
 */
export interface FaucetConfig {
  conn: Connection;
  key: Keypair;
  usdcMint: PublicKey;
  usdcDecimals: number;
  /** Test USDC per claim, in base units. */
  usdcPerClaim: bigint;
  /** SOL per claim, in lamports, sent only when the wallet holds less. */
  solPerClaim: number;
  /** Sign and send; injectable so the route can be tested without a chain. */
  send?: (tx: Transaction) => Promise<string>;
  now?: () => number;
}

const DAY_MS = 86_400_000;

export function faucetFromEnv(): FaucetConfig | null {
  const secret = process.env.FAUCET_SECRET;
  const rpc = process.env.SOLANA_DEVNET_RPC_URL;
  if (!secret || !rpc) return null;
  const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret) as number[]));
  return {
    conn: new Connection(rpc, "confirmed"),
    key,
    usdcMint: new PublicKey(process.env.FAUCET_USDC_MINT ?? "8HcqMLJJxoG3fAkgNk8Qm3Uv7oXhXLM8X5xE4FXZe3Cg"),
    usdcDecimals: 6,
    usdcPerClaim: BigInt(Math.round(Number(process.env.FAUCET_USDC ?? "100") * 1e6)),
    solPerClaim: Math.round(Number(process.env.FAUCET_SOL ?? "0.02") * LAMPORTS_PER_SOL),
  };
}

export function mountFaucet(app: Express, cfg: FaucetConfig): void {
  const now = cfg.now ?? Date.now;
  const claimed = new Map<string, number>();
  const faucetUsdc = getAssociatedTokenAddressSync(cfg.usdcMint, cfg.key.publicKey);
  const send = cfg.send ?? (async (tx: Transaction) => {
    const latest = await cfg.conn.getLatestBlockhash("confirmed");
    tx.feePayer = cfg.key.publicKey;
    tx.recentBlockhash = latest.blockhash;
    tx.sign(cfg.key);
    const signature = await cfg.conn.sendRawTransaction(tx.serialize());
    const result = await cfg.conn.confirmTransaction({ signature, ...latest }, "confirmed");
    if (result.value.err) throw new Error(`faucet transfer failed: ${JSON.stringify(result.value.err)}`);
    return signature;
  });

  app.get("/v1/stocks/faucet", async (_req, res) => {
    const [usdc, sol] = await Promise.all([
      cfg.conn.getTokenAccountBalance(faucetUsdc).then((b) => b.value.amount).catch(() => "0"),
      cfg.conn.getBalance(cfg.key.publicKey).catch(() => 0),
    ]);
    res.json({
      network: "solana-devnet",
      faucet: cfg.key.publicKey.toBase58(),
      usdcMint: cfg.usdcMint.toBase58(),
      usdcPerClaim: cfg.usdcPerClaim.toString(),
      solPerClaim: cfg.solPerClaim,
      remaining: { usdc, lamports: sol },
      rule: "one claim per wallet per day",
    });
  });

  app.post(
    "/v1/stocks/faucet",
    rateLimit({ name: "faucet", windowMs: 3_600_000, limit: 5 }),
    express.json({ limit: "2kb" }),
    async (req, res) => {
      let owner: PublicKey;
      try {
        owner = new PublicKey(String(req.body?.owner ?? ""));
      } catch {
        return res.status(400).json({ error: { code: "INVALID_OWNER", message: "owner must be a Solana wallet address" } });
      }
      if (!PublicKey.isOnCurve(owner.toBytes())) {
        return res.status(400).json({ error: { code: "INVALID_OWNER", message: "owner must be a wallet, not a program address" } });
      }
      const key = owner.toBase58();
      const last = claimed.get(key);
      if (last !== undefined && now() - last < DAY_MS) {
        return res.status(429).json({ error: { code: "ALREADY_CLAIMED", message: "this wallet claimed in the last day", retryAfterMs: DAY_MS - (now() - last) } });
      }
      const ownerUsdc = getAssociatedTokenAddressSync(cfg.usdcMint, owner);
      const [held, lamports] = await Promise.all([
        cfg.conn.getTokenAccountBalance(ownerUsdc).then((b) => BigInt(b.value.amount)).catch(() => 0n),
        cfg.conn.getBalance(owner),
      ]);
      if (held >= cfg.usdcPerClaim) {
        return res.status(409).json({ error: { code: "ALREADY_FUNDED", message: "this wallet already holds a claim's worth of test USDC" } });
      }
      // Claimed before sending, so two requests at once cannot both pass.
      claimed.set(key, now());
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(cfg.key.publicKey, ownerUsdc, owner, cfg.usdcMint, TOKEN_PROGRAM_ID),
        createTransferCheckedInstruction(faucetUsdc, cfg.usdcMint, ownerUsdc, cfg.key.publicKey, cfg.usdcPerClaim, cfg.usdcDecimals),
      );
      const sol = lamports < cfg.solPerClaim ? cfg.solPerClaim - lamports : 0;
      if (sol > 0) tx.add(SystemProgram.transfer({ fromPubkey: cfg.key.publicKey, toPubkey: owner, lamports: sol }));
      try {
        const signature = await send(tx);
        res.json({ signature, usdc: cfg.usdcPerClaim.toString(), lamports: sol, usdcAccount: ownerUsdc.toBase58() });
      } catch (err) {
        claimed.delete(key); // nothing was sent, so the wallet may try again
        res.status(502).json({ error: { code: "FAUCET_FAILED", message: ((err as Error).message ?? String(err)).slice(0, 160) } });
      }
    },
  );
  console.log(`[faucet] mounted: ${cfg.usdcPerClaim} test USDC and up to ${cfg.solPerClaim} lamports per wallet per day, from ${cfg.key.publicKey.toBase58()}`);
}
