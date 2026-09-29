/**
 * Paxos's own testnet USDG on Robinhood Chain's testnet, as a dollar a governor
 * may hold beside tUSDG. Paxos's faucet (faucet.paxos.com, Robinhood Chain
 * Testnet, 100 USDG a wallet a day) is the only source, so this opens a USDG
 * pool for a few stocks on the testnet's Uniswap v3, at each stock's feed price,
 * with liquidity 10% either side of it: enough depth for agent-sized buys from
 * little USDG. The hub's keeper holds these pools at their feeds like the others.
 *
 *   STOCKS=TSLA,AMZN USDG_PER_POOL=30 npx hardhat run scripts/stocks-robinhood-usdg.ts --network robinhoodTestnet
 *
 * It writes deployments/stocks-robinhoodTestnet-usdg.json; the stocks it opened
 * go in the USDG entry of ROBINHOOD_TESTNET.otherBudgets.
 */
import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import { ERC20_ABI, FEED_ABI, ROBINHOOD_TESTNET, instrumentOf } from "../sdk/evm-stocks";
import { sqrtPriceFor } from "../services/pool-keeper";

/** Paxos's Global Dollar on Robinhood Chain testnet (docs.paxos.com/guides/stablecoin/usdg/testnet). */
export const PAXOS_USDG_TESTNET = "0x7E955252E15c84f5768B83c41a71F9eba181802F";
const HELPER = "0x9635796d5f7c1CF9Dc2120Bb0310a8ad20AAd623"; // UniV3LiquidityHelper, owned by the deployer
const FEE = 3000; // tick spacing 60
const V3_ABI = ["function getPool(address,address,uint24) view returns (address)", "function createPool(address,address,uint24) returns (address)"];
const POOL_ABI = ["function initialize(uint160)", "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)", "function liquidity() view returns (uint128)"];
const HELPER_ABI = ["function seed(address pool, int24 tickLower, int24 tickUpper, uint128 liquidity)"];

async function main() {
  const [owner] = await ethers.getSigners();
  const n = ROBINHOOD_TESTNET;
  const venue = n.venues[0];
  const symbols = (process.env.STOCKS ?? "TSLA,AMZN").split(",").map((s) => s.trim().toUpperCase());
  const perPool = ethers.parseUnits(process.env.USDG_PER_POOL ?? "30", 6);
  const usdg = new ethers.Contract(PAXOS_USDG_TESTNET, ERC20_ABI, owner);
  const held: bigint = await usdg.balanceOf(owner.address);
  if (held < perPool * BigInt(symbols.length)) throw new Error(`the owner holds ${ethers.formatUnits(held, 6)} USDG; ${symbols.length} pools need ${ethers.formatUnits(perPool * BigInt(symbols.length), 6)} (faucet.paxos.com, 100 a day)`);
  const v3 = new ethers.Contract(venue.factory!, V3_ABI, owner);
  const helper = new ethers.Contract(HELPER, HELPER_ABI, owner);
  const pools: Record<string, string> = {};

  for (const sym of symbols) {
    const inst = instrumentOf(n, sym);
    if (!inst?.feed) throw new Error(`${sym} is not a stock with a feed on ${n.name}`);
    const round = await new ethers.Contract(inst.feed, FEED_ABI, owner).latestRoundData();
    const price = ((round.answer as bigint) * 10n ** 6n) / 10n ** 8n; // USDG units per whole share
    const usdgIs0 = PAXOS_USDG_TESTNET.toLowerCase() < inst.address.toLowerCase();
    const [t0, t1] = usdgIs0 ? [PAXOS_USDG_TESTNET, inst.address] : [inst.address, PAXOS_USDG_TESTNET];

    let poolAddress: string = await v3.getPool(t0, t1, FEE);
    if (poolAddress === ethers.ZeroAddress) {
      await (await v3.createPool(t0, t1, FEE)).wait();
      poolAddress = await v3.getPool(t0, t1, FEE);
    }
    const pool = new ethers.Contract(poolAddress, POOL_ABI, owner);
    if ((await pool.slot0()).sqrtPriceX96 === 0n) await (await pool.initialize(sqrtPriceFor(price, inst.decimals, usdgIs0))).wait();
    if ((await pool.liquidity()) > 0n) {
      console.log(`${sym}/USDG ${poolAddress} already has liquidity; left as it is`);
      pools[sym] = poolAddress;
      continue;
    }

    // The USDG and the stock it is worth at the feed, 5% more stock so USDG is the side that binds.
    const shares = (perPool * 10n ** BigInt(inst.decimals) * 105n) / price / 100n;
    await (await usdg.transfer(HELPER, perPool)).wait();
    await (await new ethers.Contract(inst.address, ERC20_ABI, owner).transfer(HELPER, shares)).wait();

    // Liquidity 10% either side, the most both amounts cover (Uniswap v3's own amount formulas).
    const { sqrtPriceX96, tick } = await pool.slot0();
    const floorTo = (t: number) => Math.floor(t / 60) * 60;
    const lower = floorTo(Number(tick) - 960), upper = floorTo(Number(tick) + 960);
    const [amt0, amt1] = usdgIs0 ? [perPool, shares] : [shares, perPool];
    const sp = Number(sqrtPriceX96) / 2 ** 96, spa = Math.pow(1.0001, lower / 2), spb = Math.pow(1.0001, upper / 2);
    const L = BigInt(Math.floor(Math.min(Number(amt0) / (1 / sp - 1 / spb), Number(amt1) / (sp - spa)) * 0.97));
    await (await helper.seed(poolAddress, lower, upper, L)).wait();
    pools[sym] = poolAddress;
    console.log(`${sym}/USDG ${poolAddress}: $${ethers.formatUnits(price, 6)} a share, ${ethers.formatUnits(perPool, 6)} USDG and ${ethers.formatUnits(shares, inst.decimals)} ${sym}, ticks ${lower}..${upper}`);
  }

  const out = { network: network.name, chainId: n.chainId, at: new Date().toISOString(), usdg: PAXOS_USDG_TESTNET, fee: FEE, pools };
  fs.writeFileSync("deployments/stocks-robinhoodTestnet-usdg.json", `${JSON.stringify(out, null, 2)}\n`);
  console.log(`owner keeps ${ethers.formatUnits(await usdg.balanceOf(owner.address), 6)} USDG`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
