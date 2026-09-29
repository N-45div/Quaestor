/**
 * Keeps a testnet's Uniswap pools at the price the chain's feeds report.
 *
 * On Robinhood Chain's testnet the feeds are MirrorFeeds of Chainlink's mainnet
 * prices, which move all day, while the tUSDG pools the governor's agents buy
 * from have no arbitrageurs: left alone they drift, and an honest agent's buy is
 * refused as too far over Chainlink's price. This keeper does what arbitrage does
 * on mainnet. For each stock whose pool is off its feed by more than a few basis
 * points, it swaps through Uniswap's own router with the feed's price as the
 * swap's price limit, so Uniswap moves the pool exactly there and takes only the
 * input it needs. It sells the stock when the pool is dear and buys it when the
 * pool is cheap, so its inventory recycles; it mints tUSDG when it runs short.
 *
 *   EVM_KEEPER_ROBINHOOD_TESTNET_KEY=0x…   the keeper's key; holds some of each stock and tUSDG
 */
import { ethers } from "ethers";
import { ERC20_ABI, FEED_ABI, budgetsOf, exactInputSingle, withBudget, type Instrument, type Network, type Venue } from "../sdk/evm-stocks";
import { safeMessage } from "../stocks/redact";

const V3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)", "function token0() view returns (address)"];
/** Move a pool once it is this far from its feed. */
export const DRIFT_BPS = 20;

const isqrt = (n: bigint) => {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
};

/**
 * Uniswap's sqrt price for a price in budget units per whole share: token1 per
 * token0 in raw units, whichever of the two sorts first.
 */
export function sqrtPriceFor(budgetPerShare: bigint, shareDecimals: number, budgetIsToken0: boolean): bigint {
  const share = 10n ** BigInt(shareDecimals);
  return budgetIsToken0 ? isqrt((share << 192n) / budgetPerShare) : isqrt((budgetPerShare << 192n) / share);
}

/** The pool's price in budget units per whole share, from its sqrt price. */
export function priceFromSqrt(sqrtPriceX96: bigint, shareDecimals: number, budgetIsToken0: boolean): bigint {
  const share = 10n ** BigInt(shareDecimals);
  const ratioX192 = sqrtPriceX96 * sqrtPriceX96; // token1 per token0, times 2^192
  return budgetIsToken0 ? (share << 192n) / ratioX192 : (ratioX192 * share) >> 192n;
}

export interface KeeperConfig {
  network: Network;
  provider: ethers.Provider;
  keeperKey: string;
  fee?: number;
}

export class PoolKeeper {
  private busy = false;
  constructor(private readonly cfg: KeeperConfig) {}

  /** One pass over every stock, against every dollar the chain lists: what each pool was, and what was done. */
  async tick(): Promise<{ stock: string; budget: string; poolPrice: string; feedPrice: string; driftBps: number; tx?: string; note?: string }[]> {
    if (this.busy) return [];
    this.busy = true;
    try {
      const { network, provider, keeperKey } = this.cfg;
      const venue = network.venues.find((v) => v.kind === "uniswap-v3");
      if (!venue?.factory) return [];
      const wallet = new ethers.Wallet(keeperKey, provider);
      const out = [];
      for (const b of budgetsOf(network)) {
        const n = withBudget(network, b.address);
        for (const inst of n.instruments) {
          if (!inst.feed) continue;
          const row = await this.keep(wallet, venue, inst, n);
          if (row) out.push(row);
        }
      }
      return out;
    } finally {
      this.busy = false;
    }
  }

  private async keep(wallet: ethers.Wallet, venue: Venue, inst: Instrument, network: Network) {
    const { provider } = this.cfg;
    const b = network.budget;
    const fee = this.cfg.fee ?? inst.fees[0] ?? 3000;
    const poolAddress: string = await new ethers.Contract(venue.factory!, V3_FACTORY_ABI, provider).getPool(b.address, inst.address, fee);
    if (poolAddress === ethers.ZeroAddress) return null; // no pool against this dollar
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
    const [slot0, token0, round, feedDecimals] = await Promise.all([
      pool.slot0(),
      pool.token0() as Promise<string>,
      new ethers.Contract(inst.feed!, FEED_ABI, provider).latestRoundData(),
      new ethers.Contract(inst.feed!, FEED_ABI, provider).decimals(),
    ]);
    const budgetIsToken0 = token0.toLowerCase() === b.address.toLowerCase();
    const feedPrice = ((round.answer as bigint) * 10n ** BigInt(b.decimals)) / 10n ** BigInt(feedDecimals);
    const poolPrice = priceFromSqrt(slot0.sqrtPriceX96 as bigint, inst.decimals, budgetIsToken0);
    const driftBps = Number(((poolPrice - feedPrice) * 10_000n) / feedPrice);
    const fmt = (v: bigint) => ethers.formatUnits(v, b.decimals);
    const row = { stock: inst.symbol, budget: b.symbol, poolPrice: fmt(poolPrice), feedPrice: fmt(feedPrice), driftBps };
    if (Math.abs(driftBps) < DRIFT_BPS) return row;

    // Dear pool: sell the share into it. Cheap pool: buy the share with tUSDG.
    const sellShare = poolPrice > feedPrice;
    const tokenIn = sellShare ? inst.address : b.address;
    const tokenOut = sellShare ? b.address : inst.address;
    const target = sqrtPriceFor(feedPrice, inst.decimals, budgetIsToken0);
    const inToken = new ethers.Contract(tokenIn, [...ERC20_ABI, "function mint(address,uint256)"], wallet);
    let held: bigint = await inToken.balanceOf(wallet.address);
    if (!sellShare && held < 1_000n * 10n ** BigInt(b.decimals) && b.mintable) {
      await (await inToken.mint(wallet.address, 10_000n * 10n ** BigInt(b.decimals))).wait();
      held = await inToken.balanceOf(wallet.address);
    }
    if (held === 0n) return { ...row, note: `no ${sellShare ? inst.symbol : b.symbol} to trade with` };
    if ((await inToken.allowance(wallet.address, venue.router)) < held) await (await inToken.approve(venue.router, ethers.MaxUint256)).wait();
    // The whole balance offered, the feed's price as the limit: Uniswap stops there and keeps the rest.
    const data = exactInputSingle(venue, tokenIn, tokenOut, fee, wallet.address, held, 0n, target);
    const tx = await wallet.sendTransaction({ to: venue.router, data });
    await tx.wait(1, 90_000);
    return { ...row, tx: tx.hash };
  }

  start(everyMs = 10 * 60_000): void {
    const run = () => this.tick()
      .then((rows) => {
        const moved = rows.filter((r) => r.tx);
        if (moved.length) console.log(`[pool-keeper] ${this.cfg.network.name}: ${moved.map((r) => `${r.stock}/${r.budget} ${r.driftBps} bps`).join(", ")} moved to the feed`);
      })
      .catch((e) => console.error(`[pool-keeper] ${this.cfg.network.name}: ${safeMessage(e, 200)}`));
    void run();
    setInterval(run, everyMs).unref?.();
  }
}
