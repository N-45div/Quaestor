/**
 * Quaestor's trading governor on HSK Chain: the factory, and for each instrument a price a contract can read.
 *
 *   npx hardhat run scripts/deploy-hsk.ts --network hskMainnet          # for real
 *   FORK_HSK=1 npx hardhat run scripts/deploy-hsk.ts                    # the same on a fork, for the gas
 *   HSK_TOKENS=WHSK,WETH                                                # which instruments (default all three)
 *
 * APRO's feeds on HSK Chain refuse contracts ("No access"), so each instrument's guard reads its HSKSwap USDT pool's
 * own 30-minute average (contracts/UniV3TwapFeed.sol). These pools keep one observation, which makes any average fail
 * for half an hour after a swap, so each pool is first asked to keep 16 (anyone may ask; the caller pays the gas).
 * Recorded in deployments/stocks-<network>.json; a step already done is not repeated.
 */
import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { HSK_MAINNET as HSK } from "../sdk/evm-stocks";

const WINDOW = 1800;
const CARDINALITY = 16;
const V3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function increaseObservationCardinalityNext(uint16 observationCardinalityNext)",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  if (Number(chainId) !== HSK.chainId) throw new Error(`expected HSK Chain (177), got ${chainId}`);
  const start = await ethers.provider.getBalance(deployer.address);
  console.log(`${network.name} (${chainId}) deployer ${deployer.address}, ${ethers.formatEther(start)} HSK`);

  const file = path.join(process.cwd(), "deployments", `stocks-${network.name === "hardhat" ? "hskFork" : network.name}.json`);
  const out: any = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { network: network.name, chainId: Number(chainId), deployer: deployer.address, contracts: {}, feeds: {} };
  const save = () => fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  const spent: string[] = [];
  const note = (what: string, r: { gasUsed: bigint; gasPrice?: bigint | null }) => {
    const cost = r.gasUsed * (r.gasPrice ?? 0n);
    spent.push(`${what}: ${r.gasUsed} gas, ${ethers.formatEther(cost)} HSK`);
    console.log(`  ${spent[spent.length - 1]}`);
  };

  if (!out.contracts.QuaestorStocks) {
    const Factory = await ethers.getContractFactory("QuaestorStocks");
    const estimate = await ethers.provider.estimateGas({ ...(await Factory.getDeployTransaction()), from: deployer.address });
    const factory = await Factory.deploy({ gasLimit: (estimate * 110n) / 100n });
    const receipt = (await factory.deploymentTransaction()!.wait())!;
    out.contracts.QuaestorStocks = await factory.getAddress();
    // The public RPC can answer a read from a node a block behind its own receipt: ask again for a while.
    for (let i = 0; !out.contracts.QuaestorStockGovernorImplementation; i++) {
      try {
        out.contracts.QuaestorStockGovernorImplementation = await factory.implementation();
      } catch (err) {
        if (i >= 15) throw err;
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    out.tx = receipt.hash;
    out.block = receipt.blockNumber;
    out.deployedAt = new Date().toISOString();
    save();
    console.log(`factory ${out.contracts.QuaestorStocks} (block ${receipt.blockNumber})`);
    note("factory", receipt);
  }

  const wanted = (process.env.HSK_TOKENS ?? HSK.instruments.map((i) => i.symbol).join(",")).split(",").map((s) => s.trim());
  const v3 = new ethers.Contract(HSK.venues[0].factory!, V3_FACTORY_ABI, deployer);
  for (const symbol of wanted) {
    const inst = HSK.instruments.find((i) => i.symbol === symbol);
    if (!inst) throw new Error(`no instrument ${symbol} on HSK Chain`);
    if (out.feeds[symbol]?.feed) { console.log(`${symbol}: feed ${out.feeds[symbol].feed} already deployed`); continue; }
    const poolAddress: string = await v3.getPool(inst.address, HSK.budget.address, inst.fees[0]);
    if (poolAddress === ethers.ZeroAddress) throw new Error(`no ${symbol}/USDT pool at ${inst.fees[0]}`);
    const pool = new ethers.Contract(poolAddress, POOL_ABI, deployer);
    const s = await pool.slot0();
    if (Number(s.observationCardinalityNext) < CARDINALITY) {
      const r = (await (await pool.increaseObservationCardinalityNext(CARDINALITY)).wait())!;
      note(`${symbol} pool history ${s.observationCardinalityNext} -> ${CARDINALITY}`, r);
    }
    const Feed = await ethers.getContractFactory("UniV3TwapFeed");
    const feed = await Feed.deploy(poolAddress, inst.address, WINDOW, `${symbol} / USDT, HSKSwap ${WINDOW / 60}-minute TWAP`);
    const r = (await feed.deploymentTransaction()!.wait())!;
    out.feeds[symbol] = { pool: poolAddress, feed: await feed.getAddress(), window: WINDOW, block: r.blockNumber };
    save();
    note(`${symbol} feed ${out.feeds[symbol].feed}`, r);
  }

  const end = await ethers.provider.getBalance(deployer.address);
  console.log(`spent ${ethers.formatEther(start - end)} HSK; ${ethers.formatEther(end)} left. Recorded in ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
