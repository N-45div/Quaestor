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

  // Per-chain RPC + explorer for the dashboard. EXPLORER_TX / EXPLORER_ADDR override.
  const chainId = out.chainId;
  const CHAINS: Record<number, { rpc: string; tx: string; addr: string }> = {
    31337: { rpc: "http://127.0.0.1:8545", tx: "", addr: "" },
    1952: { rpc: process.env.XLAYER_TESTNET_RPC ?? "https://testrpc.xlayer.tech", tx: "https://www.oklink.com/xlayer-test/tx/", addr: "https://www.oklink.com/xlayer-test/address/" },
    196: { rpc: process.env.XLAYER_RPC ?? "https://rpc.xlayer.tech", tx: "https://www.oklink.com/xlayer/tx/", addr: "https://www.oklink.com/xlayer/address/" },
    5042002: { rpc: process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.io", tx: "https://testnet.arcscan.app/tx/", addr: "https://testnet.arcscan.app/address/" },
    296: { rpc: process.env.HEDERA_TESTNET_RPC ?? "https://testnet.hashio.io/api", tx: "https://hashscan.io/testnet/transaction/", addr: "https://hashscan.io/testnet/account/" },
    295: { rpc: process.env.HEDERA_MAINNET_RPC ?? "https://mainnet.hashio.io/api", tx: "https://hashscan.io/mainnet/transaction/", addr: "https://hashscan.io/mainnet/account/" },
    11155111: { rpc: process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com", tx: "https://sepolia.etherscan.io/tx/", addr: "https://sepolia.etherscan.io/address/" },
    84532: { rpc: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org", tx: "https://sepolia.basescan.org/tx/", addr: "https://sepolia.basescan.org/address/" },
    102031: { rpc: process.env.CREDITCOIN_RPC ?? "https://rpc.cc3-testnet.creditcoin.network", tx: "https://creditcoin-testnet.blockscout.com/tx/", addr: "https://creditcoin-testnet.blockscout.com/address/" },
  };
  const chain = CHAINS[chainId] ?? { rpc: "", tx: "", addr: "" };
  const appConfig = {
    network: network.name,
    chainId,
    rpcUrl: chain.rpc,
    explorerTx: process.env.EXPLORER_TX ?? chain.tx,
    explorerAddr: process.env.EXPLORER_ADDR ?? chain.addr,
    startBlock: Math.max(0, (await ethers.provider.getBlockNumber()) - 10),
    decisionLedgerUrl:
      process.env.SERVICES_URL ??
      (chainId === 31337 ? "http://localhost:8402" : ""),
    contracts: out.contracts,
  };
  // Every deployment gets its own dashboard config. The dashboard's default
  // (config.json) only changes when asked — a deploy to a new chain must not
  // silently repoint the live app.
  const appDir = path.join(__dirname, "..", "app", "public");
  const perChain = path.join(appDir, `config.${network.name === "localhost" ? "local" : network.name}.json`);
  fs.writeFileSync(perChain, JSON.stringify(appConfig, null, 2));
  console.log(`Dashboard config written to ${perChain}`);
  if (process.env.APP_CONFIG === "1" || network.name === "localhost") {
    const appFile = path.join(appDir, "config.json");
    fs.writeFileSync(appFile, JSON.stringify(appConfig, null, 2));
    console.log(`Dashboard default config updated: ${appFile}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
