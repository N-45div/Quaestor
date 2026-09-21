import { expect } from "chai";
import express from "express";
import type { Server } from "node:http";
import { ethers } from "hardhat";
import { startIndexer } from "../services/indexer";
import { Category } from "../sdk";

/**
 * The explorer's indexer on a QuaestorV2 governor. V2 indexes the payee, so a
 * receipt read with the original ABI would put it in the wrong place — which
 * is exactly the row a person opens to see who was paid.
 */
describe("explorer indexer — QuaestorV2 receipts", () => {
  let server: Server;
  afterEach(() => server?.close());

  async function receiptsFrom(version: 1 | 2) {
    const [owner, operator, payee] = await ethers.getSigners();
    const governor = await (await ethers.getContractFactory("QuaestorV2")).deploy();
    await governor.connect(owner).registerAgent(operator.address, 86_400, "ipfs://cato", { value: 10n ** 18n });
    await governor.connect(owner).setPolicy(1, Category.DATA, 10n ** 17n, 10n ** 16n);
    const start = await ethers.provider.getBlockNumber();
    await (await governor.connect(operator).pay(1, Category.DATA, payee.address, 10n ** 15n, ethers.id("record"))).wait();

    const app = express();
    const indexer = startIndexer(app, ethers.provider, await governor.getAddress(), 60_000, {
      chainId: 31337, route: "/receipts", startBlock: start, range: 50, governorVersion: version,
    });
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    // One tick has run by the time the first response comes back with rows.
    let body: { receipts: Array<{ payee: string; amount: string; metaHash: string }> } = { receipts: [] };
    for (let i = 0; i < 40 && body.receipts.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      body = (await (await fetch(`${base}/receipts`)).json()) as typeof body;
    }
    indexer.stop();
    return { rows: body.receipts, payee: payee.address };
  }

  it("reads the payee, amount and metaHash of a V2 receipt correctly", async () => {
    const { rows, payee } = await receiptsFrom(2);
    expect(rows).to.have.length(1);
    expect(rows[0].payee).to.equal(payee);
    expect(rows[0].amount).to.equal(String(10n ** 15n));
    expect(rows[0].metaHash).to.equal(ethers.id("record"));
  });

  it("does not read a V2 receipt as the original governor's, which would misplace the payee", async () => {
    const { rows, payee } = await receiptsFrom(1);
    // Either the row is dropped or its payee is wrong; neither may pass as right.
    expect(rows.every((row) => row.payee !== payee)).to.equal(true);
  });
});
