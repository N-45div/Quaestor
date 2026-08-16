import type { Express } from "express";
import { ethers } from "ethers";
import { DEX_ABI, verifyReceipt } from "../sdk";

/**
 * Paid market-signal API, settled on-chain through Quaestor (x402-style):
 *   GET /quote   -> free: price in wei + the collector address to pay
 *   GET /signal  -> requires header `x-quaestor-tx: <txHash>` containing a
 *                   Quaestor Receipt paying the collector >= the price.
 *                   One receipt buys exactly one signal (replay-guarded).
 *
 * The signal is honest data: spot/SMA/momentum sampled from QuaestorDEX.
 */

export interface OracleConfig {
  provider: ethers.JsonRpcProvider;
  quaestorAddress: string;
  dexAddress: string;
  tokenAddress: string;
  collector: string;
  priceWei: bigint;
  sampleMs: number;
}

export function oracleConfigFromEnv(provider: ethers.JsonRpcProvider): OracleConfig {
  const required = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var ${name}`);
    return v;
  };
  return {
    provider,
    quaestorAddress: required("QUAESTOR_ADDRESS"),
    dexAddress: required("DEX_ADDRESS"),
    tokenAddress: required("QUSD_ADDRESS"),
    collector: required("ORACLE_COLLECTOR_ADDRESS"),
    priceWei: ethers.parseEther(process.env.ORACLE_PRICE_OKB ?? "0.001"),
    sampleMs: Number(process.env.ORACLE_SAMPLE_MS ?? 15_000),
  };
}

interface Sample {
  at: number;
  /** token units per 1 OKB, in wei */
  spot: bigint;
}

const MAX_SAMPLES = 240;

export interface OracleHandle {
  stop: () => void;
  /** Latest computed signal, or null before the first sample lands. */
  currentSignal: () => Record<string, unknown> | null;
}

export function mountOracle(app: Express, cfg: OracleConfig): OracleHandle {
  const dex = new ethers.Contract(cfg.dexAddress, DEX_ABI, cfg.provider);
  const history: Sample[] = [];
  const usedReceipts = new Set<string>();

  const sample = async () => {
    try {
      const spot: bigint = await dex.spotPrice(cfg.tokenAddress);
      if (spot > 0n) {
        history.push({ at: Date.now(), spot });
        if (history.length > MAX_SAMPLES) history.shift();
      }
    } catch (err) {
      console.error("[oracle] sample failed:", (err as Error).message);
    }
  };

  const computeSignal = () => {
    const latest = history[history.length - 1];
    const window = history.slice(-20);
    const sma = window.reduce((acc, s) => acc + s.spot, 0n) / BigInt(window.length);
    const momentumBps = Number(((latest.spot - sma) * 10_000n) / sma);
    return {
      token: cfg.tokenAddress,
      spotTokenPerOkb: latest.spot.toString(),
      smaTokenPerOkb: sma.toString(),
      momentumBps,
      samples: history.length,
      sampledAt: new Date(latest.at).toISOString(),
    };
  };

  app.get("/quote", (_req, res) => {
    res.json({
      description: "QuaestorDEX market signal (spot, SMA, momentum)",
      priceWei: cfg.priceWei.toString(),
      payee: cfg.collector,
      settlement: {
        contract: cfg.quaestorAddress,
        method: "pay(agentId, DATA, payee, amount, metaHash)",
        header: "x-quaestor-tx",
      },
    });
  });

  app.get("/signal", async (req, res) => {
    const txHash = req.header("x-quaestor-tx");
    if (!txHash) {
      return res.status(402).json({
        error: "payment required",
        priceWei: cfg.priceWei.toString(),
        payee: cfg.collector,
        how: "pay via Quaestor, then retry with header x-quaestor-tx: <txHash>",
      });
    }
    if (usedReceipts.has(txHash.toLowerCase())) {
      return res.status(409).json({ error: "receipt already redeemed" });
    }

    const verdict = await verifyReceipt(cfg.provider, cfg.quaestorAddress, txHash, {
      payee: cfg.collector,
      minAmountWei: cfg.priceWei,
    });
    if (!verdict.ok) {
      return res.status(402).json({ error: `payment not accepted: ${verdict.reason}` });
    }
    if (history.length === 0) {
      return res.status(503).json({ error: "no samples yet, retry shortly" });
    }

    usedReceipts.add(txHash.toLowerCase());
    res.json({
      paidBy: {
        agentId: verdict.agentId?.toString(),
        amountWei: verdict.amount?.toString(),
      },
      signal: computeSignal(),
    });
  });

  void sample();
  const timer = setInterval(sample, cfg.sampleMs);
  console.log(
    `[oracle] mounted — collector ${cfg.collector}, ${ethers.formatEther(cfg.priceWei)} OKB/signal`
  );
  return {
    stop: () => clearInterval(timer),
    currentSignal: () => (history.length ? computeSignal() : null),
  };
}
