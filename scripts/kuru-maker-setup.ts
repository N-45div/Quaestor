/**
 * Hand the Kuru market's quoting to the hub's market maker: fund the maker's key
 * with gas and tETH (deposited into Kuru's margin account, where Kuru's resting
 * orders draw from), and cancel the deployer's setup asks, so the book holds
 * only the maker's quotes, which follow Chainlink.
 *
 *   npx hardhat run scripts/kuru-maker-setup.ts --network monadTestnet
 *
 * The maker's key is EVM_MAKER_MONAD_TESTNET_KEY in .env, never printed.
 */
import { ethers } from "hardhat";
import { ERC20_ABI, MONAD_TESTNET } from "../sdk/evm-stocks";

const KURU_MARGIN = "0xd029C2D98ff85D8F64799017fE00a59B1159CE02";
const MARGIN_ABI = ["function deposit(address _user, address _token, uint256 _amount) payable", "function getBalance(address _user, address _token) view returns (uint256)"];
const BOOK_ABI = [
  "function batchCancelOrders(uint40[] _orderIds)",
  "function s_orders(uint40) view returns (address ownerAddress, uint96 size, uint40 prev, uint40 next, uint40 flippedId, uint32 price, uint32 flippedPrice, bool isBuy)",
  "event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const key = process.env.EVM_MAKER_MONAD_TESTNET_KEY;
  if (!key) throw new Error("EVM_MAKER_MONAD_TESTNET_KEY is not in .env");
  const maker = new ethers.Wallet(key, ethers.provider);
  const n = MONAD_TESTNET;
  const inst = n.instruments[0];
  const market = n.venues[0].markets![inst.address.toLowerCase()].address;
  console.log(`maker ${maker.address}, market ${market}`);

  // Gas, and tETH (a test token anyone may mint) into Kuru's margin account.
  if ((await ethers.provider.getBalance(maker.address)) < ethers.parseEther("0.3")) {
    await (await deployer.sendTransaction({ to: maker.address, value: ethers.parseEther("0.5") })).wait();
  }
  const teth = new ethers.Contract(inst.address, [...ERC20_ABI, "function mint(address,uint256)"], maker);
  const margin = new ethers.Contract(KURU_MARGIN, MARGIN_ABI, maker);
  const inMargin: bigint = await margin.getBalance(maker.address, inst.address);
  if (inMargin < 5n * 10n ** 18n) {
    const amount = 10n * 10n ** 18n;
    await (await teth.mint(maker.address, amount)).wait();
    await (await teth.approve(KURU_MARGIN, amount)).wait();
    await (await margin.deposit(maker.address, inst.address, amount)).wait();
  }
  console.log(`maker holds ${ethers.formatEther(await margin.getBalance(maker.address, inst.address))} tETH in Kuru's margin account`);

  // The deployer's setup asks, found from the book's own events, cancelled.
  const book = new ethers.Contract(market, BOOK_ABI, deployer);
  const head = await ethers.provider.getBlockNumber();
  const ids: bigint[] = [];
  for (let from = n.factoryBlock; from <= head; from += 100) {
    const logs = await book.queryFilter(book.filters.OrderCreated(), from, Math.min(head, from + 99));
    for (const l of logs) {
      const e = book.interface.parseLog(l)!;
      if ((e.args.owner as string).toLowerCase() === deployer.address.toLowerCase()) ids.push(e.args.orderId as bigint);
    }
    if (ids.length >= 3) break;
  }
  const alive: bigint[] = [];
  for (const id of ids) {
    const o = await book.s_orders(id);
    if ((o.ownerAddress as string).toLowerCase() === deployer.address.toLowerCase() && (o.size as bigint) > 0n) alive.push(id);
  }
  if (alive.length) await (await book.batchCancelOrders(alive)).wait();
  console.log(`cancelled the deployer's setup asks: ${alive.join(", ") || "none left"}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
