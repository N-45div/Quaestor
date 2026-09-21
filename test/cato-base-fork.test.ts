import { expect } from "chai";
import express from "express";
import type { Server } from "node:http";
import { ethers, network } from "hardhat";
import { cycle, type AgentRuntime } from "../agent";
import { mountOracle } from "../services/oracle";
import { Category, QUAESTOR_LOG_ABI, QUAESTOR_V2_ABI, QuaestorAgent } from "../sdk";
import { quoteExactInputSingle, UNISWAP_BASE } from "../sdk/uniswap";

/**
 * One whole cycle of Cato against the real Uniswap, on a fork of Base mainnet:
 * pay the oracle for a signal, size the buy, swap ETH for USDC through the
 * governor, and publish the record behind each spend to QuaestorLog.
 *
 *   FORK_BASE=1 npx hardhat test test/cato-base-fork.test.ts
 */
(process.env.FORK_BASE ? describe : describe.skip)("Cato on Base, through the real Uniswap", function () {
  this.timeout(180_000);
  let server: Server;

  after(async () => {
    server?.close();
    if (process.env.FORK_BASE) await network.provider.send("hardhat_reset");
  });

  it("runs a cycle: a paid signal, a governed Uniswap buy, and both records on chain", async () => {
    const [owner, operator, collector] = await ethers.getSigners();
    // Logs are read from here on: asking a fork for logs from block 0 asks the
    // upstream node to scan all of Base.
    const start = await ethers.provider.getBlockNumber();
    const governor = await (await ethers.getContractFactory("QuaestorV2")).deploy();
    const log = await (await ethers.getContractFactory("QuaestorLog")).deploy();
    const address = await governor.getAddress();

    // The owner's part: register, fund, cap, and allow Uniswap and USDC.
    await governor.connect(owner).registerAgent(operator.address, 86_400, "ipfs://cato", { value: ethers.parseEther("0.1") });
    await governor.connect(owner).setPolicy(1, Category.DATA, ethers.parseEther("0.001"), ethers.parseEther("0.0001"));
    await governor.connect(owner).setPolicy(1, Category.EXECUTION, ethers.parseEther("0.05"), ethers.parseEther("0.02"));
    await governor.connect(owner).setVenue(1, UNISWAP_BASE.swapRouter02, true);
    await governor.connect(owner).setInstrument(1, UNISWAP_BASE.usdc, true);

    // The oracle, priced from the forked pool.
    const probe = ethers.parseEther("0.01");
    const app = express();
    const oracle = mountOracle(app, {
      provider: ethers.provider,
      quaestorAddress: address,
      governorVersion: 2,
      spot: async () => ((await quoteExactInputSingle(ethers.provider, UNISWAP_BASE, UNISWAP_BASE.usdc, probe)) * 10n ** 18n) / probe,
      source: "Uniswap v3 on a Base fork",
      tokenAddress: UNISWAP_BASE.usdc,
      tokenDecimals: 6,
      nativeSymbol: "ETH",
      collector: collector.address,
      priceWei: ethers.parseEther("0.00001"),
      sampleMs: 60_000,
    });
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    const oracleUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await new Promise((r) => setTimeout(r, 1_500));

    const sdk = new QuaestorAgent({
      rpcUrl: "unused",
      signer: operator,
      quaestorAddress: address,
      governorVersion: 2,
      logAddress: await log.getAddress(),
      receiptDir: require("node:os").tmpdir(),
    });
    const rt: AgentRuntime = {
      sdk,
      venue: UNISWAP_BASE,
      nativeSymbol: "ETH",
      agentId: 1n,
      agentName: "Cato",
      tokenAddress: UNISWAP_BASE.usdc,
      oracleUrl,
      intervalMs: 60_000,
      baseBuyOkb: "0.01",
      openrouterModel: "unused",
      inferenceFeeOkb: "0",
      budgets: null,
      governor: address,
      burstMultiple: 3,
    };

    const usdc = new ethers.Contract(UNISWAP_BASE.usdc, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
    const before = await usdc.balanceOf(owner.address);
    const lines: string[] = [];
    await cycle(rt, (line) => lines.push(line));
    oracle.stop();

    // The owner holds USDC it did not hold before.
    const received = (await usdc.balanceOf(owner.address)) - before;
    expect(received, lines.join("\n")).to.be.greaterThan(0n);
    expect(lines.some((l) => l.startsWith("EXECUTION swapped") && l.includes("via Uniswap")), lines.join("\n")).to.equal(true);

    // Every Receipt's metaHash has a published record that hashes to it.
    const receipts = (await ethers.provider.getLogs({ address, fromBlock: start }))
      .map((l) => new ethers.Interface(QUAESTOR_V2_ABI).parseLog(l))
      .filter((p) => p?.name === "Receipt");
    const published = (await ethers.provider.getLogs({ address: await log.getAddress(), fromBlock: start }))
      .map((l) => new ethers.Interface(QUAESTOR_LOG_ABI).parseLog(l)!);
    expect(receipts.length).to.equal(2); // DATA and EXECUTION; no LLM, so no INFERENCE
    for (const receipt of receipts) {
      const record = published.find((p) => p.args.metaHash === receipt!.args.metaHash);
      expect(record, `no record for ${receipt!.args.metaHash}`).to.not.equal(undefined);
      expect(ethers.keccak256(record!.args.record)).to.equal(receipt!.args.metaHash);
    }
  });
});
