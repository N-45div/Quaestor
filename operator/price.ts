/**
 * What a budget token that is not a dollar is worth, so the Operator can keep agreeing every amount in dollars and
 * escrow the token at a price it can show.
 *
 * WIF on Robinhood Chain: its Uniswap v4 pool against ETH, read straight from the PoolManager's storage (the pool's
 * slot0 through extsload, no periphery contract), and ETH from Chainlink's ETH / USD on the same chain. A Chainlink
 * answer older than two of its heartbeats is refused, and so is a pool with no liquidity: no price, no escrow.
 *
 * A pool's spot price can be pushed for a block. Whoever accepts an offer chooses when its escrow happens, so a
 * payee could push WIF down just before to be escrowed more of it. The rate used is therefore the lower of the spot
 * and the median of this process's readings over the last half hour, in token units per dollar: the budget never
 * pays more WIF than the recent market says a dollar buys. The owner's caps, set in WIF, bound the rest.
 */
import { ethers } from "ethers";
import type { UniswapV4EthPrice } from "./networks";

export interface PriceReading {
  /** Token base units one micro-dollar (1e-6 USD) buys: the rate deals are escrowed at. */
  unitsPerMicroUsd: bigint;
  /** The same, from this block's pool price alone. */
  spotUnitsPerMicroUsd: bigint;
  /** Dollars for one whole token, for people to read. */
  usdPerToken: number;
  ethUsd: number;
  /** Unix seconds of Chainlink's answer. */
  ethUsdUpdatedAt: number;
  source: string;
}

export interface Pricer {
  read(): Promise<PriceReading>;
}

export class PriceUnavailable extends Error {}

const POOLS_SLOT = 6n; // Uniswap v4's PoolManager keeps its pools at storage slot 6 (StateLibrary.POOLS_SLOT)
const Q192 = 1n << 192n;
const FEED_ABI = ["function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"];
const PM_ABI = ["function extsload(bytes32 slot) view returns (bytes32)"];
const STALE_AFTER = 2 * 86_400; // two of the ETH / USD feed's 24-hour heartbeats
const WINDOW_MS = 30 * 60_000;
const SAMPLE_EVERY_MS = 60_000;
const CACHE_MS = 30_000;

/** The pool's slot0 and liquidity words, from the PoolManager's own storage. */
export function poolSlots(poolId: string): { slot0: string; liquidity: string } {
  const base = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [poolId, POOLS_SLOT])));
  return { slot0: ethers.toBeHex(base, 32), liquidity: ethers.toBeHex(base + 3n, 32) };
}

/**
 * Token base units per micro-dollar, from the pool's sqrtPriceX96 and ETH's 8-decimal Chainlink answer. The pool's
 * price is currency1 per currency0 in base units; with ETH as currency0, that is token units per wei.
 */
export function unitsPerMicroUsd(sqrtPriceX96: bigint, ethUsd8: bigint, tokenIsCurrency1: boolean): bigint {
  if (sqrtPriceX96 === 0n || ethUsd8 <= 0n) throw new PriceUnavailable("no price");
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  // units per ETH = 1e18 wei × (units per wei); one micro-dollar is ethUsd8 / 1e8 × 1e6 of an ETH's worth, inverted.
  const unitsPerEth = tokenIsCurrency1 ? (p2 * 10n ** 18n) / Q192 : (Q192 * 10n ** 18n) / p2;
  return (unitsPerEth * 100n) / ethUsd8;
}

const median = (xs: bigint[]) => {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor(s.length / 2)];
};

export class UniswapV4EthPricer implements Pricer {
  private readonly pm: ethers.Contract;
  private readonly feed: ethers.Contract;
  private samples: { at: number; v: bigint }[] = [];
  private cached: { at: number; reading: PriceReading } | null = null;

  constructor(private readonly cfg: UniswapV4EthPrice, provider: ethers.Provider, private readonly now = () => Date.now()) {
    this.pm = new ethers.Contract(cfg.poolManager, PM_ABI, provider);
    this.feed = new ethers.Contract(cfg.ethUsdFeed, FEED_ABI, provider);
  }

  async read(): Promise<PriceReading> {
    const t = this.now();
    if (this.cached && t - this.cached.at < CACHE_MS) return this.cached.reading;
    const slots = poolSlots(this.cfg.poolId);
    const [slot0, liquidity, round] = await Promise.all([this.pm.extsload(slots.slot0), this.pm.extsload(slots.liquidity), this.feed.latestRoundData()]);
    const sqrtPriceX96 = BigInt(slot0) & ((1n << 160n) - 1n);
    if ((BigInt(liquidity) & ((1n << 128n) - 1n)) === 0n) throw new PriceUnavailable("the pool has no liquidity");
    const ethUsd8 = BigInt(round.answer);
    const updatedAt = Number(round.updatedAt);
    if (Math.floor(t / 1000) - updatedAt > STALE_AFTER) throw new PriceUnavailable(`Chainlink's ETH / USD is ${Math.round((t / 1000 - updatedAt) / 3600)} hours old`);
    const spot = unitsPerMicroUsd(sqrtPriceX96, ethUsd8, this.cfg.tokenIsCurrency1);

    this.samples = this.samples.filter((s) => t - s.at <= WINDOW_MS);
    if (!this.samples.length || t - this.samples[this.samples.length - 1].at >= SAMPLE_EVERY_MS) this.samples.push({ at: t, v: spot });
    const recent = median(this.samples.map((s) => s.v));
    const rate = spot < recent ? spot : recent;
    const reading: PriceReading = {
      unitsPerMicroUsd: rate,
      spotUnitsPerMicroUsd: spot,
      usdPerToken: 1e12 / Number(rate),
      ethUsd: Number(ethUsd8) / 1e8,
      ethUsdUpdatedAt: updatedAt,
      source: this.cfg.source,
    };
    this.cached = { at: t, reading };
    return reading;
  }
}
