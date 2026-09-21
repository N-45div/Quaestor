import type { Express } from "express";
import { ethers } from "ethers";
import { DEX_ABI, governorVersionFromEnv, verifyReceipt, type GovernorVersion } from "../sdk";
import { quoteExactInputSingle, UNISWAP_BASE } from "../sdk/uniswap";

/**
 * Paid market-signal API, settled on-chain through Quaestor (x402-style):
 *   GET /quote   -> free: price in wei + the collector address to pay
 *   GET /signal  -> requires header `x-quaestor-tx: <txHash>` containing a
 *                   Quaestor Receipt paying the collector >= the price.
 *                   One receipt buys exactly one signal (replay-guarded).
 *
 * The signal is honest data: spot/SMA/momentum sampled from a real price. On
 * the original deployment that is QuaestorDEX; on Base it is Uniswap's own
 * quoter for the ETH/USDC pool the agent trades.
 */

/** Token base units bought by one whole native coin, right now. */
export type SpotSource = () => Promise<bigint>;

export interface OracleConfig {
  provider: ethers.Provider;
  quaestorAddress: string;
  governorVersion: GovernorVersion;
  spot: SpotSource;
  /** What the price is of, for anyone reading the signal. */
  source: string;
  tokenAddress: string;
  tokenDecimals: number;
  nativeSymbol: string;
  collector: string;
  priceWei: bigint;
  sampleMs: number;
}

export function oracleConfigFromEnv(provider: ethers.Provider): OracleConfig {
  const required = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var ${name}`);
    return v;
  };
  const nativeSymbol = process.env.NATIVE_SYMBOL ?? "OKB";
  const common = {
    provider,
    quaestorAddress: required("QUAESTOR_ADDRESS"),
    governorVersion: governorVersionFromEnv(),
    nativeSymbol,
    collector: required("ORACLE_COLLECTOR_ADDRESS"),
    priceWei: ethers.parseEther(process.env.ORACLE_PRICE ?? process.env.ORACLE_PRICE_OKB ?? "0.001"),
    sampleMs: Number(process.env.ORACLE_SAMPLE_MS ?? 15_000),
  };
  if (process.env.ORACLE_SOURCE === "uniswap-v3") {
    // A small probe, scaled to a whole coin: a 1 ETH quote carries its own
    // price impact, which a signal about the market should not.
    const probe = ethers.parseEther("0.01");
    const tokenAddress = process.env.ORACLE_TOKEN ?? UNISWAP_BASE.usdc;
    return {
      ...common,
      spot: async () => ((await quoteExactInputSingle(provider, UNISWAP_BASE, tokenAddress, probe)) * 10n ** 18n) / probe,
      source: `Uniswap v3 ${nativeSymbol}/USDC ${(UNISWAP_BASE.fee / 10_000).toFixed(2)}% on Base (quoter ${UNISWAP_BASE.quoterV2})`,
      tokenAddress,
      tokenDecimals: Number(process.env.ORACLE_TOKEN_DECIMALS ?? 6),
    };
  }
  const dex = new ethers.Contract(required("DEX_ADDRESS"), DEX_ABI, provider);
  const tokenAddress = required("QUSD_ADDRESS");
  return {
    ...common,
    spot: async () => (await dex.spotPrice(tokenAddress)) as bigint,
    source: "QuaestorDEX market signal (spot, SMA, momentum)",
    tokenAddress,
    tokenDecimals: 18,
  };
}

interface Sample {
  at: number;
  /** token base units per 1 native coin */
  spot: bigint;
}

const MAX_SAMPLES = 240;

export interface OracleHandle {
  stop: () => void;
  /** Latest computed signal, or null before the first sample lands. */
  currentSignal: () => Record<string, unknown> | null;
}

export function mountOracle(app: Express, cfg: OracleConfig): OracleHandle {
  const history: Sample[] = [];
  const usedReceipts = new Set<string>();
  // Redeemed receipts are remembered in memory, so a restart forgets them. A
  // receipt from before this process started could then be redeemed twice.
  // Rather than keep that list somewhere, anything mined before the first
  // block this process saw is refused: the one case it costs is an agent that
  // paid in the moment before a restart and asked after it.
  let bootBlock: number | null = null;
  void cfg.provider.getBlockNumber().then((n) => { bootBlock = n; }, () => undefined);

  const sample = async () => {
    try {
      const spot = await cfg.spot();
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
      source: cfg.source,
      token: cfg.tokenAddress,
      tokenDecimals: cfg.tokenDecimals,
      // Kept under their original names so existing agents keep reading them;
      // the unit is the token's base unit per one native coin.
      spotTokenPerOkb: latest.spot.toString(),
      smaTokenPerOkb: sma.toString(),
      momentumBps,
      samples: history.length,
      sampledAt: new Date(latest.at).toISOString(),
    };
  };

  app.get("/quote", (_req, res) => {
    res.json({
      description: cfg.source,
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
    if (bootBlock === null) {
      return res.status(503).json({ error: "the oracle has not read the chain yet, retry shortly" });
    }

    const verdict = await verifyReceipt(cfg.provider, cfg.quaestorAddress, txHash, {
      payee: cfg.collector,
      minAmountWei: cfg.priceWei,
      version: cfg.governorVersion,
    });
    if (!verdict.ok) {
      return res.status(402).json({ error: `payment not accepted: ${verdict.reason}` });
    }
    const mined = (await cfg.provider.getTransactionReceipt(txHash))?.blockNumber ?? 0;
    if (mined < bootBlock) {
      return res.status(409).json({
        error: "receipt predates this oracle's last restart, so it cannot be checked against redemptions made before it",
        receiptBlock: mined,
        oracleSince: bootBlock,
      });
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
    `[oracle] mounted — ${cfg.source}; collector ${cfg.collector}, ${ethers.formatEther(cfg.priceWei)} ${cfg.nativeSymbol}/signal`
  );
  return {
    stop: () => clearInterval(timer),
    currentSignal: () => (history.length ? computeSignal() : null),
  };
}
