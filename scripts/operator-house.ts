/**
 * Quaestor pays for its own outreach through Quaestor Operator: the house project's budget on
 * Arc testnet. Opens a payout governor owned by the deployer, whose operator is the hub's key
 * (OP_KEY_ARC_TESTNET), with CCTP forwarding on so a payee can be paid on their own chain, and
 * writes the seed the hub loads at boot (OP_PROJECTS_FILE).
 *
 *   npx hardhat run scripts/operator-house.ts --network arcTestnet
 *
 *   WITHDRAW_FROM=0x…   first take an old test governor's free balance back to the owner
 *   DEPOSIT=10          test USDC to put in
 */
import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import { OP_NETWORKS } from "../operator/networks";

const u = (n: number) => BigInt(Math.round(n * 1e6));

const BRIEF = `Quaestor gives AI agents money they cannot overspend. An owner puts a budget in a governor contract with caps per trade, per period and per counterparty; the agent works inside it, and the hash of every decision it makes goes on-chain with the action, so anyone can check why money moved. It runs on Base, Arbitrum, Robinhood Chain, Monad, Solana and Arc.

Quaestor Operator, the agent reading this application, is built on it: it pays contributors from a USDC budget on Arc, escrows each deal, and pays only for delivered work. This budget is on Arc testnet, so payments are test USDC.

We want people who build or run AI agents, or wallets and payments for them, to understand what Quaestor does and try it. Good work explains one concrete thing in the author's own words and accurately: a cap that refused a trade, a decision hash anyone can re-check, a payout that crossed chains. It links quaestor-app.onrender.com or the GitHub repo. We do not pay for engagement bait, giveaways, threads of hashtags, or posts that only tag accounts.`;

const TASKS = [
  { id: "quaestor-post", kind: "x-post", title: "A post on X about Quaestor", done_when: "A public post on X that explains, in your own words, one concrete thing Quaestor does for AI agents, and links quaestor-app.onrender.com or the GitHub repo.", rate_min_usd: 1, rate_max_usd: 3, slots: 5 },
  { id: "quaestor-pr", kind: "pull-request", title: "A merged pull request to Quaestor", done_when: "A pull request merged into github.com/N-45div/Quaestor that fixes a bug, adds a test, or makes the docs clearer.", rate_min_usd: 2, rate_max_usd: 5, slots: 3 },
  { id: "quaestor-article", kind: "article", title: "An article or tutorial", done_when: "A public article or tutorial that walks through using Quaestor (an agent with a budget, a governor, a refusal) with accurate steps.", rate_min_usd: 2, rate_max_usd: 5, slots: 3 },
  { id: "quaestor-video", kind: "video", title: "A video walkthrough", done_when: "A public YouTube video, two minutes or more, showing Quaestor in use: an agent working inside its budget, and the governor refusing it.", rate_min_usd: 3, rate_max_usd: 5, slots: 2 },
];

async function main() {
  if (network.name !== "arcTestnet") throw new Error("run with --network arcTestnet");
  const net = OP_NETWORKS["arc-testnet"];
  const [owner] = await ethers.getSigners();
  const opKey = process.env.OP_KEY_ARC_TESTNET;
  if (!opKey) throw new Error("OP_KEY_ARC_TESTNET is not set");
  const operator = new ethers.Wallet(opKey).address;
  const usdc = new ethers.Contract(net.usdc, ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], owner);
  console.log(`owner ${owner.address}, operator ${operator}`);

  const from = process.env.WITHDRAW_FROM;
  if (from) {
    const old = new ethers.Contract(from, ["function freeBalance() view returns (uint256)", "function withdraw(address to, uint256 amount)"], owner);
    const free = (await old.freeBalance()) as bigint;
    if (free > 0n) {
      await (await old.withdraw(owner.address, free)).wait();
      console.log(`took ${ethers.formatUnits(free, 6)} USDC back from ${from}`);
    }
  }

  const deposit = u(Number(process.env.DEPOSIT ?? 10));
  console.log(`owner holds ${ethers.formatUnits(await usdc.balanceOf(owner.address), 6)} USDC`);
  const factory = await ethers.getContractAt("QuaestorPayouts", net.factory!, owner);
  await (await usdc.approve(net.factory!, deposit)).wait();
  const setup = {
    operator, token: net.usdc, epochLength: 7 * 86_400, perDealCap: u(5), epochCap: u(10), newPayeeCap: u(3), newPayeesPerEpoch: 5,
    payees: [], payeeCaps: [], tokenMessenger: net.tokenMessenger!, maxForwardFeeBps: 1000, deposit,
  };
  const gas = ethers.parseEther("1"); // native USDC, 18 decimals: the operator's gas
  const governor = await factory.createGovernor.staticCall(setup, { value: gas });
  const receipt = (await (await factory.createGovernor(setup, { value: gas })).wait())!;
  console.log(`governor ${governor} (tx ${receipt.hash})`);

  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync("deployments/operator-house-arcTestnet.json", JSON.stringify({
    network: network.name, chainId: net.chainId, at: new Date().toISOString(), owner: owner.address, operator, governor, tx: receipt.hash, setup: { ...setup, perDealCap: "5", epochCap: "10", newPayeeCap: "3", deposit: ethers.formatUnits(deposit, 6) },
  }, null, 2) + "\n");
  fs.mkdirSync("operator/projects", { recursive: true });
  fs.writeFileSync("operator/projects/house-arc-testnet.json", JSON.stringify([{
    id: "quaestor", name: "Quaestor", owner_address: owner.address, network: "arc-testnet", governor, brief: BRIEF,
    links: ["https://quaestor-app.onrender.com/", "https://github.com/N-45div/Quaestor"], tasks: TASKS,
  }], null, 2) + "\n");
  console.log("wrote deployments/operator-house-arcTestnet.json and operator/projects/house-arc-testnet.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
