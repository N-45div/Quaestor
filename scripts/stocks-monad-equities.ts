/**
 * Tokenized-stock markets on Kuru's order book, on Monad testnet.
 *
 * No Stock Token trades on Monad, and Chainlink publishes no stock feed there,
 * so for each stock this brings what Robinhood Chain has natively: a test
 * stand-in token (anyone may mint it; it is a test token, not a share), a
 * MirrorFeed holding Chainlink's own price for the stock from Robinhood Chain
 * mainnet (the hub relays it, only when it moves, since Monad charges every
 * transaction its whole gas limit), and a Kuru spot market for it against
 * tUSDC through Kuru's permissionless Router. The hub's maker then keeps asks on
 * it just over Chainlink's price, and governors buy it under the same checks.
 *
 *   STOCKS=TSLA npx hardhat run scripts/stocks-monad-equities.ts --network monadTestnet
 *
 * EVM_MIRROR_MONAD_TESTNET_KEY (the relayer) and EVM_MAKER_MONAD_TESTNET_KEY (the
 * maker, whose margin account gets some of each stand-in) are read from .env.
 * It writes deployments/stocks-monadTestnet-equities.json.
 */
import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import { ERC20_ABI, FEED_ABI, KURU_ROUTER_ABI, MONAD_TESTNET, ROBINHOOD } from "../sdk/evm-stocks";

const KURU_MARGIN = "0xd029C2D98ff85D8F64799017fE00a59B1159CE02";
const MARGIN_ABI = ["function deposit(address _user, address _token, uint256 _amount) payable", "function getBalance(address _user, address _token) view returns (uint256)"];
// The same book units as the tETH market: prices in 1e-4 dollars on a one-cent tick,
// sizes in 1e-9 of a share, at least a thousandth of a share an order.
const PRICE_PRECISION = 10_000;
const SIZE_PRECISION = 1_000_000_000n;
const TICK = 100;
const MIN_SIZE = 1_000_000n;
const MAX_SIZE = 10n ** 12n;
const MAKER_SHARES = 2n * 10n ** 18n;

async function main() {
  const [owner] = await ethers.getSigners();
  const log = (m: string) => console.log(`[${network.name}] ${m}`);
  const relayer = new ethers.Wallet(process.env.EVM_MIRROR_MONAD_TESTNET_KEY ?? "", ethers.provider);
  const maker = new ethers.Wallet(process.env.EVM_MAKER_MONAD_TESTNET_KEY ?? "", ethers.provider);
  const symbols = (process.env.STOCKS ?? "TSLA").split(",").map((s) => s.trim().toUpperCase());
  const mainnet = new ethers.JsonRpcProvider(ROBINHOOD.rpcUrl, ROBINHOOD.chainId, { staticNetwork: true });
  const tusdc = MONAD_TESTNET.budget.address;
  log(`owner ${owner.address} ${ethers.formatEther(await ethers.provider.getBalance(owner.address))} MON, relayer ${relayer.address}, maker ${maker.address}`);

  // The relayer pays for its own copies; a little MON covers weeks of moves.
  if ((await ethers.provider.getBalance(relayer.address)) < ethers.parseEther("0.05")) {
    await (await owner.sendTransaction({ to: relayer.address, value: ethers.parseEther("0.1"), gasLimit: 21_000n })).wait();
  }

  const out: Record<string, { token: string; feed: string; market: string; source: string; price: number }> = {};
  for (const sym of symbols) {
    const src = ROBINHOOD.instruments.find((i) => i.symbol === sym);
    if (!src?.feed) throw new Error(`${sym} has no Chainlink feed on Robinhood Chain mainnet; one of ${ROBINHOOD.instruments.map((i) => i.symbol).join(", ")}`);
    const round = await new ethers.Contract(src.feed, FEED_ABI, mainnet).latestRoundData();
    const price = Number(round.answer) / 1e8;

    const token = await (await ethers.getContractFactory("MockERC20")).deploy(`${src.name} (test stand-in, Quaestor)`, `t${sym}`, 18);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();

    const feed = await (await ethers.getContractFactory("MirrorFeed")).deploy(relayer.address, 8, src.feed, `${sym} / USD (Monad testnet mirror of Chainlink's Robinhood Chain mainnet feed)`);
    await feed.waitForDeployment();
    const feedAddress = await feed.getAddress();
    await (await (feed.connect(relayer) as typeof feed).mirror(round.answer, round.updatedAt)).wait();

    const router = new ethers.Contract(MONAD_TESTNET.venues[0].router, KURU_ROUTER_ABI, owner);
    const args = [0, tokenAddress, tusdc, SIZE_PRECISION, PRICE_PRECISION, TICK, MIN_SIZE, MAX_SIZE, 0, 0, 100] as const;
    const market: string = await router.deployProxy.staticCall(...args);
    await (await router.deployProxy(...args)).wait();

    // The maker's stock, in Kuru's margin account where resting asks draw from.
    const asMaker = new ethers.Contract(tokenAddress, [...ERC20_ABI, "function mint(address,uint256)"], maker);
    await (await asMaker.mint(maker.address, MAKER_SHARES)).wait();
    await (await asMaker.approve(KURU_MARGIN, MAKER_SHARES)).wait();
    await (await new ethers.Contract(KURU_MARGIN, MARGIN_ABI, maker).deposit(maker.address, tokenAddress, MAKER_SHARES)).wait();

    out[sym] = { token: tokenAddress, feed: feedAddress, market, source: src.feed, price };
    log(`t${sym} ${tokenAddress}, mirror ${feedAddress} at $${price}, Kuru market ${market}`);
  }

  const file = "deployments/stocks-monadTestnet-equities.json";
  fs.writeFileSync(file, `${JSON.stringify({ network: network.name, chainId: MONAD_TESTNET.chainId, at: new Date().toISOString(), relayer: relayer.address, stocks: out }, null, 2)}\n`);
  log(`wrote ${file}; owner has ${ethers.formatEther(await ethers.provider.getBalance(owner.address))} MON left`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
