import { createPublicClient, encodeFunctionData, http, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { chainOf, type EvmInstrument, type EvmNetwork } from "./stocks";

/**
 * What a venue says an amount of the governor's dollar buys, and the swap a page
 * sends for it. The page proposes; the governor's wallet reads only the intent
 * (stock, amount, floor) out of the swap and has the governor do it.
 */

const QUOTER_ABI = parseAbi(["function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)"]);
const ROUTER02_ABI = parseAbi(["function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)"]);
const KURU_BOOK_ABI = parseAbi(["function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)"]);
const KURU_ROUTER_ABI = parseAbi(["function anyToAnySwap(address[] _marketAddresses, bool[] _isBuy, bool[] _nativeSend, address _debitToken, address _creditToken, uint256 _amount, uint256 _minAmountOut) payable returns (uint256)"]);
const FEED_ABI = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function decimals() view returns (uint8)"]);

export interface PageQuote {
  venueLabel: string;
  router: Address;
  amountOut: bigint;
  /** In the dollar's base units per whole share. */
  price: bigint;
  chainlink: bigint | null;
  premiumBps: number | null;
  /** The swap, paid to `recipient`, with this floor. */
  swap: (recipient: Address, minOut: bigint) => Hex;
}

export async function quoteBuy(net: EvmNetwork, inst: EvmInstrument, amountIn: bigint): Promise<PageQuote> {
  const client = createPublicClient({ chain: chainOf(net), transport: http(net.rpcUrl) });
  const b = net.budget;
  const quotes: Omit<PageQuote, "price" | "chainlink" | "premiumBps">[] = [];
  for (const v of net.venues) {
    if (v.kind === "uniswap-v3" && v.quoter) {
      for (const fee of inst.fees) {
        try {
          const { result } = await client.simulateContract({ address: v.quoter, abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ tokenIn: b.address, tokenOut: inst.address, amountIn, fee, sqrtPriceLimitX96: 0n }] });
          quotes.push({
            venueLabel: `Uniswap v3 ${fee / 10_000}% pool`, router: v.router, amountOut: result[0],
            swap: (recipient, minOut) => encodeFunctionData({ abi: ROUTER02_ABI, functionName: "exactInputSingle", args: [{ tokenIn: b.address, tokenOut: inst.address, fee, recipient, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] }),
          });
        } catch { /* no pool at this tier */ }
      }
    }
    const market = v.kind === "kuru" ? v.markets?.[inst.address.toLowerCase()] : undefined;
    if (market) {
      try {
        const quoteSize = (amountIn * BigInt(market.pricePrecision)) / 10n ** BigInt(b.decimals);
        const { result } = await client.simulateContract({ address: market.address, abi: KURU_BOOK_ABI, functionName: "placeAndExecuteMarketBuy", args: [quoteSize, 0n, false, false], account: zeroAddress });
        if (result > 0n) {
          quotes.push({
            venueLabel: "Kuru order book", router: v.router, amountOut: result,
            swap: (_recipient, minOut) => encodeFunctionData({ abi: KURU_ROUTER_ABI, functionName: "anyToAnySwap", args: [[market.address], [true], [false], b.address, inst.address, amountIn, minOut] }),
          });
        }
      } catch { /* the book cannot fill it */ }
    }
  }
  const best = quotes.sort((x, y) => (y.amountOut > x.amountOut ? 1 : -1))[0];
  if (!best) throw new Error(`No venue on ${net.name} quotes ${inst.symbol} for ${b.symbol} right now.`);
  const price = (amountIn * 10n ** BigInt(inst.decimals)) / best.amountOut;
  let chainlink: bigint | null = null;
  if (inst.feed) {
    try {
      const [dec, round] = await Promise.all([
        client.readContract({ address: inst.feed, abi: FEED_ABI, functionName: "decimals" }),
        client.readContract({ address: inst.feed, abi: FEED_ABI, functionName: "latestRoundData" }),
      ]);
      chainlink = (round[1] * 10n ** BigInt(b.decimals)) / 10n ** BigInt(dec);
    } catch { chainlink = null; }
  }
  const premiumBps = chainlink && chainlink > 0n ? Number(((price - chainlink) * 10_000n) / chainlink) : null;
  return { ...best, price, chainlink, premiumBps };
}
