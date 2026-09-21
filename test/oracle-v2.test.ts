import { expect } from "chai";
import express from "express";
import type { Server } from "node:http";
import { ethers } from "hardhat";
import { mountOracle, type OracleConfig } from "../services/oracle";
import { Category, QuaestorAgent, type DecisionMeta } from "../sdk";

/**
 * The paid signal, paid for through a V2 governor. The price source here is a
 * stub that moves on demand; the point is the payment check and the replay
 * guard, which the Base fork test does not need to repeat.
 */
describe("oracle — paid through QuaestorV2", () => {
  const PRICE = 10n ** 15n;
  let server: Server;
  let base: string;
  let spot = 2_700_000_000n;

  async function setup() {
    const [owner, operator, collector] = await ethers.getSigners();
    const governor = await (await ethers.getContractFactory("QuaestorV2")).deploy();
    await governor.connect(owner).registerAgent(operator.address, 86_400, "ipfs://cato", { value: 10n ** 18n });
    await governor.connect(owner).setPolicy(1, Category.DATA, 10n ** 17n, 10n ** 16n);
    const cfg: OracleConfig = {
      provider: ethers.provider,
      quaestorAddress: await governor.getAddress(),
      governorVersion: 2,
      spot: async () => spot,
      source: "stub",
      tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      tokenDecimals: 6,
      nativeSymbol: "ETH",
      collector: collector.address,
      priceWei: PRICE,
      sampleMs: 60_000,
    };
    const app = express();
    const handle = mountOracle(app, cfg);
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    // Let the first sample and the boot block land.
    await new Promise((r) => setTimeout(r, 50));
    const agent = new QuaestorAgent({ rpcUrl: "unused", signer: operator, quaestorAddress: cfg.quaestorAddress, governorVersion: 2, receiptDir: require("node:os").tmpdir() });
    return { agent, handle, collector };
  }

  const meta: DecisionMeta = { agent: "Cato", action: "buy-market-signal", rationale: "test", timestamp: "2026-09-22T00:00:00Z" };

  afterEach(() => server?.close());

  it("sells a signal for a V2 receipt that pays the collector, once", async () => {
    const { agent, handle, collector } = await setup();
    const { txHash } = await agent.pay(1n, Category.DATA, collector.address, PRICE, meta);

    const first = await fetch(`${base}/signal`, { headers: { "x-quaestor-tx": txHash } });
    expect(first.status).to.equal(200);
    const body = (await first.json()) as { signal: { tokenDecimals: number; spotTokenPerOkb: string } };
    expect(body.signal.tokenDecimals).to.equal(6);
    expect(body.signal.spotTokenPerOkb).to.equal("2700000000");

    const again = await fetch(`${base}/signal`, { headers: { "x-quaestor-tx": txHash } });
    expect(again.status).to.equal(409);
    handle.stop();
  });

  it("refuses a V2 receipt that paid someone else", async () => {
    const { agent, handle } = await setup();
    const [, , , elsewhere] = await ethers.getSigners();
    const { txHash } = await agent.pay(1n, Category.DATA, elsewhere.address, PRICE, meta);
    const res = await fetch(`${base}/signal`, { headers: { "x-quaestor-tx": txHash } });
    expect(res.status).to.equal(402);
    handle.stop();
  });

  it("refuses a receipt mined before the oracle started, since it cannot know if that one was redeemed", async () => {
    const [owner, operator, collector] = await ethers.getSigners();
    const governor = await (await ethers.getContractFactory("QuaestorV2")).deploy();
    await governor.connect(owner).registerAgent(operator.address, 86_400, "ipfs://cato", { value: 10n ** 18n });
    await governor.connect(owner).setPolicy(1, Category.DATA, 10n ** 17n, 10n ** 16n);
    const agent = new QuaestorAgent({ rpcUrl: "unused", signer: operator, quaestorAddress: await governor.getAddress(), governorVersion: 2, receiptDir: require("node:os").tmpdir() });
    // Paid, and then the oracle "restarts".
    const { txHash } = await agent.pay(1n, Category.DATA, collector.address, PRICE, meta);
    await ethers.provider.send("evm_mine", []);

    const app = express();
    const handle = mountOracle(app, {
      provider: ethers.provider, quaestorAddress: await governor.getAddress(), governorVersion: 2,
      spot: async () => spot, source: "stub", tokenAddress: ethers.ZeroAddress, tokenDecimals: 6,
      nativeSymbol: "ETH", collector: collector.address, priceWei: PRICE, sampleMs: 60_000,
    });
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`${base}/signal`, { headers: { "x-quaestor-tx": txHash } });
    expect(res.status).to.equal(409);
    expect(((await res.json()) as { error: string }).error).to.contain("predates");
    handle.stop();
  });
});
