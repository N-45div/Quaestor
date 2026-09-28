/**
 * A Robinhood Chain mainnet fork with a governor on it, for trying the agent's
 * command end to end without spending anything real.
 *
 *   FORK_ROBINHOOD=1 npx hardhat node                                   # terminal 1
 *   OPERATOR=0x… npx hardhat run scripts/stocks-evm-fork.ts --network localhost
 *
 * It deploys the factory, funds the owner (hardhat's first account) with USDG
 * from the chain's deepest USDG pool, opens a governor for OPERATOR exactly as
 * the register page would (AAPL and NVDA at limit prices, Chainlink guards, 50
 * USDG, gas for the agent), and writes the network file the command reads via
 * QUAESTOR_EVM_NETWORK_FILE.
 */
import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { ERC20_ABI, ROBINHOOD, label16, type Network } from "../sdk/evm-stocks";

const USDG_HOLDER = "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3"; // NVDA/USDG 0.05% pool

async function main() {
  const operator = process.env.OPERATOR;
  if (!operator || !ethers.isAddress(operator)) throw new Error("set OPERATOR to the agent key's address");
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== ROBINHOOD.chainId) throw new Error(`expected a Robinhood Chain fork (4663), got ${chainId}`);

  const [owner] = await ethers.getSigners();
  const usd = (x: number) => BigInt(Math.round(x * 1e6));

  await network.provider.request({ method: "hardhat_impersonateAccount", params: [USDG_HOLDER] });
  await network.provider.request({ method: "hardhat_setBalance", params: [USDG_HOLDER, "0x56BC75E2D63100000"] });
  const whale = await ethers.getSigner(USDG_HOLDER);
  await (await new ethers.Contract(ROBINHOOD.budget.address, ERC20_ABI, whale).transfer(owner.address, usd(500))).wait();

  const factory = await (await ethers.getContractFactory("QuaestorStocks")).deploy();
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  const factoryBlock = (await factory.deploymentTransaction()!.wait())!.blockNumber;

  await (await new ethers.Contract(ROBINHOOD.budget.address, ERC20_ABI, owner).approve(factoryAddress, usd(50))).wait();
  const aapl = ROBINHOOD.instruments.find((i) => i.symbol === "AAPL")!;
  const nvda = ROBINHOOD.instruments.find((i) => i.symbol === "NVDA")!;
  const tx = await factory.connect(owner).createGovernor({
    operator,
    budgetToken: ROBINHOOD.budget.address,
    epochLength: 86_400,
    perTradeCap: usd(5),
    epochCap: usd(20),
    venues: [ROBINHOOD.venues[0].router],
    labels: [label16(ROBINHOOD.venues[0].label)],
    tokens: [aapl.address, nvda.address],
    maxPrices: [usd(370), usd(250)],
    deposit: usd(50),
  }, { value: ethers.parseEther(ROBINHOOD.agentGas) });
  const receipt = await tx.wait();
  const created = receipt!.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "GovernorCreated");
  const governor = await ethers.getContractAt("QuaestorStockGovernor", created!.args.governor);
  for (const inst of [aapl, nvda]) await (await governor.connect(owner).setPriceGuard(inst.address, inst.feed!, 100, 3 * 86_400)).wait();

  const local: Network = { ...ROBINHOOD, key: "robinhood", name: "Robinhood Chain (local fork)", rpcUrl: "http://127.0.0.1:8545", factory: factoryAddress, factoryBlock };
  const file = path.join(process.cwd(), "runs", "stocks-evm-fork.network.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(local, null, 2));
  console.log(JSON.stringify({ factory: factoryAddress, governor: await governor.getAddress(), owner: owner.address, operator, networkFile: file }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
