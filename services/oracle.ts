import express from "express";
import { ethers } from "ethers";
import * as dotenv from "dotenv";
import { DEX_ABI, verifyReceipt } from "../sdk";

dotenv.config();

/**
 * A genuinely paid market-signal API, settled on-chain through Quaestor.
 *
 * Flow (x402-style):
 *   GET /quote          -> free: price in wei + the collector address to pay
 *   GET /signal         -> requires header `x-quaestor-tx: <txHash>` of a
 *                          Quaestor Receipt paying the collector >= the price.
 *                          Each receipt buys exactly one signal (replay-guarded).
 *
 * The signal itself is honest data: the service samples QuaestorDEX spot
 * prices on an interval and serves spot, SMA and momentum.
 */

const RPC_URL =
  process.env.RPC_URL ?? process.env.XLAYER_TESTNET_RPC ?? "http://127.0.0.1:8545";
const QUAESTOR_ADDRESS = required("QUAESTOR_ADDRESS");
const DEX_ADDRESS = required("DEX_ADDRESS");
const TOKEN_ADDRESS = required("QUSD_ADDRESS");
const COLLECTOR = required("ORACLE_COLLECTOR_ADDRESS");
const PRICE_WEI = ethers.parseEther(process.env.ORACLE_PRICE_OKB ?? "0.001");
const PORT = Number(process.env.ORACLE_PORT ?? 8402);
const SAMPLE_MS = Number(process.env.ORACLE_SAMPLE_MS ?? 15_000);

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const dex = new ethers.Contract(DEX_ADDRESS, DEX_ABI, provider);

interface Sample {
  at: number;
  /** token units per 1 OKB, in wei */
  spot: bigint;
}
const history: Sample[] = [];
const MAX_SAMPLES = 240; // ~1h at 15s

async function sample() {
  try {
    const spot: bigint = await dex.spotPrice(TOKEN_ADDRESS);
    if (spot > 0n) {
      history.push({ at: Date.now(), spot });
      if (history.length > MAX_SAMPLES) history.shift();
    }
  } catch (err) {
    console.error("sample failed:", (err as Error).message);
  }
}

function computeSignal() {
  const latest = history[history.length - 1];
  const window = history.slice(-20);
  const sma = window.reduce((acc, s) => acc + s.spot, 0n) / BigInt(window.length);
  // momentum in basis points vs the SMA; positive = OKB buying more token than average
  const momentumBps = Number(((latest.spot - sma) * 10_000n) / sma);
  return {
    token: TOKEN_ADDRESS,
    spotTokenPerOkb: latest.spot.toString(),
    smaTokenPerOkb: sma.toString(),
    momentumBps,
    samples: history.length,
    sampledAt: new Date(latest.at).toISOString(),
  };
}

const usedReceipts = new Set<string>();
const app = express();

app.get("/quote", (_req, res) => {
  res.json({
    description: "QuaestorDEX market signal (spot, SMA, momentum)",
    priceWei: PRICE_WEI.toString(),
    payee: COLLECTOR,
    settlement: {
      contract: QUAESTOR_ADDRESS,
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
      priceWei: PRICE_WEI.toString(),
      payee: COLLECTOR,
      how: "pay via Quaestor, then retry with header x-quaestor-tx: <txHash>",
    });
  }
  if (usedReceipts.has(txHash.toLowerCase())) {
    return res.status(409).json({ error: "receipt already redeemed" });
  }

  const verdict = await verifyReceipt(provider, QUAESTOR_ADDRESS, txHash, {
    payee: COLLECTOR,
    minAmountWei: PRICE_WEI,
  });
  if (!verdict.ok) {
    return res.status(402).json({ error: `payment not accepted: ${verdict.reason}` });
  }
  if (history.length === 0) {
    return res.status(503).json({ error: "no samples yet, retry shortly" });
  }

  usedReceipts.add(txHash.toLowerCase());
  res.json({
    paidBy: { agentId: verdict.agentId?.toString(), amountWei: verdict.amount?.toString() },
    signal: computeSignal(),
  });
});

async function main() {
  await sample();
  setInterval(sample, SAMPLE_MS);
  app.listen(PORT, () => {
    console.log(`Quaestor oracle listening on :${PORT}`);
    console.log(`  collector ${COLLECTOR}, price ${ethers.formatEther(PRICE_WEI)} OKB/signal`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
