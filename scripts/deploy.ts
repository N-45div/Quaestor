import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys the Quaestor stack and seeds real DEX liquidity:
 *   QuaestorDEX  — constant-product AMM (native OKB <-> token pools)
 *   qUSD, qBTC   — faucet-enabled test tokens
 *   Quaestor     — the spend governor, routing EXECUTION through the DEX
 *
 * Seed sizes come from env so scarce faucet OKB is spent deliberately:
 *   SEED_NATIVE_QUSD (default 0.2)  paired at 1 OKB = 100 qUSD
 *   SEED_NATIVE_QBTC (default 0.2)  paired at 1 OKB = 0.001 qBTC
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer ${deployer.address} (${ethers.formatEther(bal)} native)`);

  const dex = await ethers.deployContract("QuaestorDEX");
  await dex.waitForDeployment();
  console.log(`QuaestorDEX ${await dex.getAddress()}`);

  const qusd = await ethers.deployContract("TestToken", [
    "Quaestor USD",
    "qUSD",
    ethers.parseEther("1000"),
  ]);
  await qusd.waitForDeployment();
  console.log(`qUSD        ${await qusd.getAddress()}`);

  const qbtc = await ethers.deployContract("TestToken", [
    "Quaestor BTC",
    "qBTC",
    ethers.parseEther("0.01"),
  ]);
  await qbtc.waitForDeployment();
  console.log(`qBTC        ${await qbtc.getAddress()}`);

  const quaestor = await ethers.deployContract("Quaestor", [await dex.getAddress()]);
  await quaestor.waitForDeployment();
  console.log(`Quaestor    ${await quaestor.getAddress()}`);

  // ---- seed real liquidity ------------------------------------------------
  const seedQusdNative = ethers.parseEther(process.env.SEED_NATIVE_QUSD ?? "0.2");
  const seedQbtcNative = ethers.parseEther(process.env.SEED_NATIVE_QBTC ?? "0.2");
  // 1 OKB = 100 qUSD, 1 OKB = 0.001 qBTC at seed
  const seedQusdTokens = (seedQusdNative * 100n);
  const seedQbtcTokens = (seedQbtcNative / 1000n);

  await (await qusd.mint(deployer.address, seedQusdTokens)).wait();
  await (await qusd.approve(await dex.getAddress(), seedQusdTokens)).wait();
  await (
    await dex.addLiquidity(await qusd.getAddress(), seedQusdTokens, {
      value: seedQusdNative,
    })
  ).wait();
  console.log(
    `Seeded qUSD pool: ${ethers.formatEther(seedQusdNative)} OKB + ${ethers.formatEther(seedQusdTokens)} qUSD`
  );

  await (await qbtc.mint(deployer.address, seedQbtcTokens)).wait();
  await (await qbtc.approve(await dex.getAddress(), seedQbtcTokens)).wait();
  await (
    await dex.addLiquidity(await qbtc.getAddress(), seedQbtcTokens, {
      value: seedQbtcNative,
    })
  ).wait();
  console.log(
    `Seeded qBTC pool: ${ethers.formatEther(seedQbtcNative)} OKB + ${ethers.formatEther(seedQbtcTokens)} qBTC`
  );

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    contracts: {
      Quaestor: await quaestor.getAddress(),
      QuaestorDEX: await dex.getAddress(),
      qUSD: await qusd.getAddress(),
      qBTC: await qbtc.getAddress(),
    },
  };

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name === "localhost" ? "local" : network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nAddresses written to ${file}`);

  // Keep the dashboard pointed at the latest deployment.
  const chainId = out.chainId;
  const appConfig = {
    network: network.name,
    chainId,
    rpcUrl:
      chainId === 1952
        ? (process.env.XLAYER_TESTNET_RPC ?? "https://testrpc.xlayer.tech")
        : chainId === 196
          ? (process.env.XLAYER_RPC ?? "https://rpc.xlayer.tech")
          : "http://127.0.0.1:8545",
    explorerTx:
      chainId === 1952
        ? "https://www.oklink.com/xlayer-test/tx/"
        : chainId === 196
          ? "https://www.oklink.com/xlayer/tx/"
          : "",
    explorerAddr:
      chainId === 1952
        ? "https://www.oklink.com/xlayer-test/address/"
        : chainId === 196
          ? "https://www.oklink.com/xlayer/address/"
          : "",
    startBlock: Math.max(0, (await ethers.provider.getBlockNumber()) - 10),
    decisionLedgerUrl:
      process.env.SERVICES_URL ??
      (chainId === 31337 ? "http://localhost:8402" : ""),
    contracts: out.contracts,
  };
  const appFile = path.join(__dirname, "..", "app", "public", "config.json");
  fs.writeFileSync(appFile, JSON.stringify(appConfig, null, 2));
  console.log(`Dashboard config written to ${appFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
