import { ethers } from "ethers";

/**
 * Uniswap v3 on Base, as the governor's venue.
 *
 * The governor never reads a venue's calldata, so building it is the caller's
 * job, and this is where it is built. Every address here was checked on Base
 * mainnet on 21 Sep 2026 to hold code, and the fee tier is the pool that held
 * the most WETH that day (0.30%, about 9,000 WETH against 1,550 at 0.05%).
 */
export interface UniswapVenue {
  swapRouter02: string;
  quoterV2: string;
  /** The factory the quoter itself was built against; checked on 21 Sep 2026. */
  factory: string;
  weth: string;
  usdc: string;
  fee: number;
}

export const UNISWAP_BASE: UniswapVenue = {
  swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
  quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  fee: 3000,
};

/** Every fee tier Uniswap v3 deploys pools at, in hundredths of a basis point. */
export const FEE_TIERS = [100, 500, 3000, 10000] as const;

const ROUTER = new ethers.Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)",
];

/**
 * Calldata for buying `tokenOut` with native ETH. SwapRouter02 wraps the ETH it
 * is sent when the input is WETH. `recipient` must be the agent's owner: the
 * governor measures the owner's balance, and output sent anywhere else reverts.
 */
export function exactInputSingleData(
  venue: UniswapVenue,
  tokenOut: string,
  recipient: string,
  amountIn: bigint,
  minOut: bigint,
  fee: number = venue.fee,
): string {
  return ROUTER.encodeFunctionData("exactInputSingle", [{
    tokenIn: venue.weth,
    tokenOut,
    fee,
    recipient,
    amountIn,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0,
  }]);
}

/**
 * What Uniswap says `amountIn` of ETH buys right now, asked of its own quoter.
 * The quoter is not a view function — it runs the swap and reverts with the
 * answer — so it is called statically, and it costs no gas.
 */
export async function quoteExactInputSingle(
  provider: ethers.Provider,
  venue: UniswapVenue,
  tokenOut: string,
  amountIn: bigint,
  attempts = 4,
  fee: number = venue.fee,
): Promise<bigint> {
  const quoter = new ethers.Contract(venue.quoterV2, QUOTER_ABI, provider);
  // A quote is a read, so asking again is safe, and worth it: mainnet.base.org
  // drops a call now and then under load, and ethers reports that as "missing
  // revert data". By the time an agent quotes it has already paid for the
  // signal it is acting on, so one dropped call should not waste that.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const [amountOut] = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: venue.weth,
        tokenOut,
        amountIn,
        fee,
        sqrtPriceLimitX96: 0,
      });
      return amountOut as bigint;
    } catch (error) {
      const inner = (error as { info?: { error?: { message?: string; code?: number } } }).info?.error;
      // A rate limit is a wait, not a failure, and a short wait does not
      // outlast it: the first mainnet cycle was refused three times in four
      // seconds by an endpoint whose budget the hub itself had spent.
      const limited = inner?.code === -32016 || /rate limit/i.test(inner?.message ?? "");
      if (attempt >= attempts) {
        // What the endpoint itself said, which ethers folds into "missing
        // revert data" and which is the only clue to why a read failed.
        throw new Error(
          `Uniswap quote for ${amountIn} wei failed ${attempts} time(s)` +
            (inner ? `: the endpoint said ${inner.code ?? ""} ${inner.message ?? ""}`.trimEnd() : `: ${(error as Error).message?.slice(0, 120)}`),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, (limited ? 5_000 : 1_500) * attempt));
    }
  }
}

const FACTORY_ABI = ["function getPool(address, address, uint24) view returns (address)"];

export class NoPoolError extends Error {}

export interface BestQuote {
  fee: number;
  amountOut: bigint;
  /** What each tier answered: its output, or null where there is no pool or no liquidity. */
  tiers: { fee: number; amountOut: bigint | null }[];
}

/**
 * The best Uniswap v3 price for `amountIn` of ETH, across every fee tier that
 * has a pool.
 *
 * One fixed tier is not enough for a token someone else chose. Anyone can
 * create a pool at any tier without permission, so a quote from a single
 * tier can come from a thin or planted pool, and the floor set from that
 * quote protects nothing because it came from the pool being traded. Taking
 * the tier that pays the most means a planted pool only wins if it pays more
 * than the real market, which is not an attack. A tier whose pool does not
 * exist is skipped without being quoted; a token with no pool at all fails at
 * once instead of after four retries.
 */
export async function bestQuote(
  provider: ethers.Provider,
  venue: UniswapVenue,
  tokenOut: string,
  amountIn: bigint,
): Promise<BestQuote> {
  const factory = new ethers.Contract(venue.factory, FACTORY_ABI, provider);
  const tiers: BestQuote["tiers"] = [];
  for (const fee of FEE_TIERS) {
    const pool: string = await factory.getPool(venue.weth, tokenOut, fee);
    if (pool === ethers.ZeroAddress) {
      tiers.push({ fee, amountOut: null });
      continue;
    }
    try {
      tiers.push({ fee, amountOut: await quoteExactInputSingle(provider, venue, tokenOut, amountIn, 2, fee) });
    } catch {
      // A pool with no liquidity in range makes the quoter revert; it is not a price.
      tiers.push({ fee, amountOut: null });
    }
  }
  const priced = tiers.filter((t): t is { fee: number; amountOut: bigint } => t.amountOut !== null && t.amountOut > 0n);
  if (!priced.length) throw new NoPoolError(`no Uniswap v3 pool between WETH and ${tokenOut} quotes this amount at any fee tier`);
  const best = priced.reduce((a, b) => (b.amountOut > a.amountOut ? b : a));
  return { fee: best.fee, amountOut: best.amountOut, tiers };
}
