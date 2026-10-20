/**
 * Quaestor pays for its own outreach through Quaestor Operator: the house projects' budgets, a
 * USDC one on Arc testnet and a MUSD one on Mezo testnet. Opens a payout governor owned by the
 * deployer, whose operator is the hub's key on that chain, and writes the seed the hub loads at
 * boot (OP_PROJECTS_FILE takes both files, comma-separated). On Arc CCTP forwarding is on, so a
 * payee can be paid on their own chain; on Mezo every payee is paid in MUSD on Mezo.
 *
 *   npx hardhat run scripts/operator-house.ts --network arcTestnet
 *   npx hardhat run scripts/operator-house.ts --network mezoTestnet
 *
 *   WITHDRAW_FROM=0x…   first take an old test governor's free balance back to the owner
 *   DEPOSIT=10          budget to put in, in the network's token
 */
import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import { OP_NETWORKS } from "../operator/networks";

const ABOUT = "Quaestor gives AI agents money they cannot overspend. An owner puts a budget in a governor contract with caps per trade, per period and per counterparty; the agent works inside it, and the hash of every decision it makes goes on-chain with the action, so anyone can check why money moved. It runs on Base, Arbitrum, Robinhood Chain, Monad, Solana, Arc and Mezo.";
const WANT = "We want people who build or run AI agents, or wallets and payments for them, to understand what Quaestor does and try it. Good work explains one concrete thing in the author's own words and accurately: a cap that refused a trade, a decision hash anyone can re-check, a payout that crossed chains. It links quaestor.dev (or quaestor-app.onrender.com) or the GitHub repo. Every paid post, article or video says it is paid, with #ad. We do not pay for engagement bait, giveaways, threads of hashtags, or posts that only tag accounts.";

const HOUSE: Record<string, { net: string; id: string; name: string; gas: string; opKey: string; budget: string }> = {
  arcTestnet: {
    net: "arc-testnet", id: "quaestor", name: "Quaestor", gas: "1", opKey: "OP_KEY_ARC_TESTNET", // native USDC, 18 decimals
    budget: "Quaestor Operator, the agent reading this application, is built on it: it pays contributors from a USDC budget on Arc, escrows each deal, and pays only for delivered work. This budget is on Arc testnet, so payments are test USDC.",
  },
  mezoTestnet: {
    net: "mezo-testnet", id: "quaestor-mezo", name: "Quaestor on Mezo", gas: "0.001", opKey: "OP_KEY_MEZO_TESTNET", // BTC
    budget: "Quaestor Operator, the agent reading this application, is built on it: this budget is MUSD on Mezo, borrowed against Bitcoin rather than sold, held in a payout governor that escrows each deal and pays only for delivered work. It is on Mezo testnet, so payments are test MUSD.",
  },
};

const tasksFor = (prefix: string) => [
  { id: `${prefix}-post`, kind: "x-post", title: "A post on X about Quaestor", done_when: "A public post on X that explains, in your own words, one concrete thing Quaestor does for AI agents, links quaestor.dev (or quaestor-app.onrender.com) or the GitHub repo, and is marked #ad.", rate_min_usd: 1, rate_max_usd: 3, slots: 5 },
  { id: `${prefix}-pr`, kind: "pull-request", title: "A merged pull request to Quaestor", done_when: "A pull request merged into github.com/N-45div/Quaestor that fixes a bug, adds a test, or makes the docs clearer.", rate_min_usd: 2, rate_max_usd: 5, slots: 3 },
  { id: `${prefix}-article`, kind: "article", title: "An article or tutorial", done_when: "A public article or tutorial that walks through using Quaestor (an agent with a budget, a governor, a refusal) with accurate steps, and says it is sponsored (#ad or \"sponsored by Quaestor\").", rate_min_usd: 2, rate_max_usd: 5, slots: 3 },
  { id: `${prefix}-video`, kind: "video", title: "A video walkthrough", done_when: "A public YouTube video, two minutes or more, showing Quaestor in use: an agent working inside its budget, and the governor refusing it, with #ad in its title.", rate_min_usd: 3, rate_max_usd: 5, slots: 2 },
];

async function main() {
  const house = HOUSE[network.name];
  if (!house) throw new Error(`run with --network ${Object.keys(HOUSE).join(" or ")}`);
  const net = OP_NETWORKS[house.net];
  const dec = net.tokenDecimals, sym = net.tokenSymbol;
  const u = (n: number) => ethers.parseUnits(String(n), dec);
  const [owner] = await ethers.getSigners();
  const opKey = process.env[house.opKey];
  if (!opKey) throw new Error(`${house.opKey} is not set`);
  const operator = new ethers.Wallet(opKey).address;
  const token = new ethers.Contract(net.usdc, ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], owner);
  console.log(`owner ${owner.address}, operator ${operator}`);

  const from = process.env.WITHDRAW_FROM;
  if (from) {
    const old = new ethers.Contract(from, ["function freeBalance() view returns (uint256)", "function withdraw(address to, uint256 amount)"], owner);
    const free = (await old.freeBalance()) as bigint;
    if (free > 0n) {
      await (await old.withdraw(owner.address, free)).wait();
      console.log(`took ${ethers.formatUnits(free, dec)} ${sym} back from ${from}`);
    }
  }

  const deposit = u(Number(process.env.DEPOSIT ?? 10));
  console.log(`owner holds ${ethers.formatUnits(await token.balanceOf(owner.address), dec)} ${sym}`);
  const factory = await ethers.getContractAt("QuaestorPayouts", net.factory!, owner);
  await (await token.approve(net.factory!, deposit)).wait();
  const setup = {
    operator, token: net.usdc, epochLength: 7 * 86_400, perDealCap: u(5), epochCap: u(10), newPayeeCap: u(3), newPayeesPerEpoch: 5,
    payees: [], payeeCaps: [], tokenMessenger: net.tokenMessenger ?? ethers.ZeroAddress, maxForwardFeeBps: net.tokenMessenger ? 1000 : 0, deposit,
  };
  const gas = ethers.parseEther(house.gas); // the operator's gas, in the chain's native token
  const governor = await factory.createGovernor.staticCall(setup, { value: gas });
  const receipt = (await (await factory.createGovernor(setup, { value: gas })).wait())!;
  console.log(`governor ${governor} (tx ${receipt.hash})`);

  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync(`deployments/operator-house-${network.name}.json`, JSON.stringify({
    network: network.name, chainId: net.chainId, at: new Date().toISOString(), owner: owner.address, operator, governor, tx: receipt.hash,
    setup: { ...setup, perDealCap: "5", epochCap: "10", newPayeeCap: "3", deposit: ethers.formatUnits(deposit, dec), token: `${net.usdc} (${sym})`, gas: `${house.gas} ${net.gasSymbol}` },
  }, null, 2) + "\n");
  fs.mkdirSync("operator/projects", { recursive: true });
  const seed = `operator/projects/house-${house.net}.json`;
  fs.writeFileSync(seed, JSON.stringify([{
    id: house.id, name: house.name, owner_address: owner.address, network: house.net, governor, brief: `${ABOUT}\n\n${house.budget}\n\n${WANT}`,
    links: ["https://quaestor.dev/", "https://github.com/N-45div/Quaestor"], tasks: tasksFor(house.id),
  }], null, 2) + "\n");
  console.log(`wrote deployments/operator-house-${network.name}.json and ${seed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
