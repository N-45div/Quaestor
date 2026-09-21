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
  weth: string;
  usdc: string;
  fee: number;
}

export const UNISWAP_BASE: UniswapVenue = {
  swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
  quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  fee: 3000,
};

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
): string {
  return ROUTER.encodeFunctionData("exactInputSingle", [{
    tokenIn: venue.weth,
    tokenOut,
    fee: venue.fee,
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
  attempts = 3,
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
        fee: venue.fee,
        sqrtPriceLimitX96: 0,
      });
      return amountOut as bigint;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_500 * attempt));
    }
  }
}
