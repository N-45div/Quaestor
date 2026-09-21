import { expect } from "chai";
import express from "express";
import type { Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { ethers } from "hardhat";
import { chainRecordSource, mountLedger, subgraphRecordSource, type RecordSource } from "../services/ledger";

/**
 * The ledger after a restart: a record it no longer holds, found where it was
 * published for good, and never one that does not hash to what was asked.
 */
describe("ledger — records that outlive the host", () => {
  let server: Server;
  afterEach(() => server?.close());

  async function serve(sources: RecordSource[]) {
    const app = express();
    // A fresh directory each time: a restarted host has nothing on disk.
    mountLedger(app, path.join(os.tmpdir(), `ledger-${Date.now()}-${Math.random()}`), sources);
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  it("finds a record on chain that this host never saw, and says where it came from", async () => {
    const log = await (await ethers.getContractFactory("QuaestorLog")).deploy();
    const record = JSON.stringify({ agent: "Cato", action: "dca-buy", rationale: "dip", timestamp: "2026-09-22T00:00:00Z" });
    await (await log.publish(ethers.toUtf8Bytes(record))).wait();
    const metaHash = ethers.keccak256(ethers.toUtf8Bytes(record));

    const base = await serve([chainRecordSource(ethers.provider, await log.getAddress(), 0)]);
    const res = await fetch(`${base}/decisions/${metaHash}`);
    expect(res.status).to.equal(200);
    expect(res.headers.get("x-record-source")).to.equal("chain");
    expect(await res.text()).to.equal(record);
  });

  it("refuses an indexer's answer that does not hash to the record asked for", async () => {
    const asked = ethers.keccak256(ethers.toUtf8Bytes('{"real":"record"}'));
    const lying = ethers.hexlify(ethers.toUtf8Bytes('{"words":"put in an agent\'s mouth"}'));
    const fakeSubgraph = (async () =>
      new Response(JSON.stringify({ data: { decisionRecord: { recordBytes: lying } } }), { status: 200 })) as typeof fetch;

    const base = await serve([subgraphRecordSource("http://indexer.invalid", fakeSubgraph)]);
    const res = await fetch(`${base}/decisions/${asked}`);
    expect(res.status).to.equal(404);
  });

  it("serves a subgraph answer that does hash correctly", async () => {
    const record = '{"agent":"Cato","action":"buy-market-signal"}';
    const metaHash = ethers.keccak256(ethers.toUtf8Bytes(record));
    const honest = (async () =>
      new Response(JSON.stringify({ data: { decisionRecord: { recordBytes: ethers.hexlify(ethers.toUtf8Bytes(record)) } } }), { status: 200 })) as typeof fetch;

    const base = await serve([subgraphRecordSource("http://indexer.invalid", honest)]);
    const res = await fetch(`${base}/decisions/${metaHash}`);
    expect(res.headers.get("x-record-source")).to.equal("subgraph");
    expect(await res.text()).to.equal(record);
  });

  it("falls through a source that is down to the next one", async () => {
    const log = await (await ethers.getContractFactory("QuaestorLog")).deploy();
    const record = '{"agent":"Cato","action":"meter-inference"}';
    await (await log.publish(ethers.toUtf8Bytes(record))).wait();
    const metaHash = ethers.keccak256(ethers.toUtf8Bytes(record));
    const down = (async () => new Response("", { status: 503 })) as typeof fetch;

    const base = await serve([subgraphRecordSource("http://indexer.invalid", down), chainRecordSource(ethers.provider, await log.getAddress(), 0)]);
    const res = await fetch(`${base}/decisions/${metaHash}`);
    expect(res.headers.get("x-record-source")).to.equal("chain");
  });

  it("says what it searched when nothing has the record", async () => {
    const log = await (await ethers.getContractFactory("QuaestorLog")).deploy();
    const base = await serve([chainRecordSource(ethers.provider, await log.getAddress(), 0)]);
    const res = await fetch(`${base}/decisions/${ethers.keccak256("0x1234")}`);
    expect(res.status).to.equal(404);
    const body = (await res.json()) as { searched: string[]; note: string };
    expect(body.searched).to.deep.equal(["memory", "disk", "chain"]);
    expect(body.note).to.contain("QuaestorLog");
  });
});
