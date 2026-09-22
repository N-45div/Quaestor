import { expect } from "chai";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Connection, Keypair } from "@solana/web3.js";
import { STOCKS_PROGRAM_ID } from "../solana/client";
import { DEVNET_RELAY_PATH, mountDevnetRelay, type DevnetRelayConfig } from "../services/devnet-relay";
import { relayingFetch } from "../solana/relay-fetch";

/**
 * The explorer's devnet reads, relayed through the hub's keyed RPC: only the
 * reads it lists, only the governor's program, what everyone reads alike
 * fetched once and kept a few seconds, a budget it cannot exceed, and no
 * error that shows the key. Then web3.js itself, reading through the relay
 * and sending past it, and falling back when the relay is not there.
 */
describe("devnet relay — the explorer's reads through the hub's keyed RPC", () => {
  const KEYED = "https://devnet.helius-rpc.example/?api-key=relay-test-secret-0123456789";
  const servers: Server[] = [];
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })));
  });

  type Reply = (method: string, params: unknown[], now: number) => unknown;

  /** A relay on a loopback port, in front of an upstream that records each call and answers with `reply`. */
  type Limits = Pick<DevnetRelayConfig, "creditsPerMinute" | "creditsPerDay" | "callsPerSecond" | "paceMs">;
  async function serve(reply: Reply, limits: Limits = { creditsPerMinute: 1_000, creditsPerDay: 100_000, callsPerSecond: 100 }) {
    const clock = { t: 1_800_000_000_000 };
    const calls: { method: string; params: unknown[] }[] = [];
    const app = express();
    mountDevnetRelay(app, {
      rpcUrl: KEYED,
      ...limits,
      now: () => clock.t,
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        calls.push({ method, params });
        const out = await reply(method, params, clock.t);
        return out instanceof Response ? out : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(out as object) }));
      }) as typeof fetch,
    });
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${DEVNET_RELAY_PATH}`;
    const post = async (body: unknown) => {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify(body) });
      return { status: res.status, cache: res.headers.get("x-relay-cache"), text: await res.text() };
    };
    return { url, post, calls, clock };
  }

  const call = (method: string, params: unknown[] = [], id: number | string = 1) => ({ jsonrpc: "2.0", id, method, params });
  const scan = (size = 179, program = STOCKS_PROGRAM_ID.toBase58()) =>
    call("getProgramAccounts", [program, { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: size }] }]);
  const balance = { result: { context: { slot: 1 }, value: 42 } };

  it("relays the explorer's reads, and refuses anything that writes or is not on its list", async () => {
    const { post, calls } = await serve(() => balance);
    const read = await post(call("getBalance", [Keypair.generate().publicKey.toBase58()], 7));
    expect(read.status).to.equal(200);
    expect(JSON.parse(read.text)).to.deep.equal({ jsonrpc: "2.0", id: 7, ...balance });
    for (const method of ["sendTransaction", "simulateTransaction", "requestAirdrop", "getLatestBlockhash", "getSignatureStatuses"]) {
      const refused = await post(call(method, ["x"]));
      expect(refused.status, method).to.equal(400);
      expect(JSON.parse(refused.text).error.code, method).to.equal(-32601);
    }
    expect(calls.map((c) => c.method)).to.deep.equal(["getBalance"]);
  });

  it("scans the governor's program and no other, and reads at most a hundred accounts at once", async () => {
    const { post, calls } = await serve(() => ({ result: [] }));
    expect((await post(scan())).status).to.equal(200);
    const other = await post(scan(165, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
    expect(other.status).to.equal(400);
    expect(JSON.parse(other.text).error.code).to.equal(-32602);
    const keys = Array.from({ length: 101 }, () => Keypair.generate().publicKey.toBase58());
    expect((await post(call("getMultipleAccounts", [keys.slice(0, 100)]))).status).to.equal(200);
    expect((await post(call("getMultipleAccounts", [keys]))).status).to.equal(400);
    expect(calls).to.have.length(2);
  });

  it("answers a batch call by call, and refuses the whole of one that is too long or holds a write", async () => {
    const { post, calls } = await serve((method) => ({ result: method }));
    const batch = await post([call("getBalance", ["a"], 1), call("getTransaction", ["sig"], "two")]);
    expect(batch.status).to.equal(200);
    expect(JSON.parse(batch.text)).to.deep.equal([
      { jsonrpc: "2.0", id: 1, result: "getBalance" },
      { jsonrpc: "2.0", id: "two", result: "getTransaction" },
    ]);
    expect((await post(Array.from({ length: 6 }, (_, i) => call("getBalance", [String(i)], i)))).status).to.equal(400);
    expect((await post([call("getBalance", ["b"]), call("sendTransaction", ["tx"])])).status).to.equal(400);
    expect((await post([])).status).to.equal(400);
    expect(calls).to.have.length(2);
  });

  it("fetches what every viewer reads alike once, however many ask, and keeps it for a few seconds", async () => {
    const { post, calls, clock } = await serve(async () => {
      await sleep(200);
      return { result: [] };
    });
    const answers = await Promise.all(Array.from({ length: 5 }, () => post(scan())));
    expect(answers.map((a) => a.status)).to.deep.equal([200, 200, 200, 200, 200]);
    expect(calls).to.have.length(1);
    expect((await post(scan())).cache).to.equal("hit");
    clock.t += 5_001;
    expect((await post(scan())).cache).to.equal("miss");
    expect(calls).to.have.length(2);
  });

  it("keeps a settled transaction for minutes, a fresh one for seconds, and a wallet's balance not at all", async () => {
    const { post, calls, clock } = await serve((method, params, now) =>
      method === "getTransaction" ? { result: { slot: 1, blockTime: Math.floor(now / 1000) - (params[0] === "old" ? 120 : 5) } } : balance);
    await post(call("getTransaction", ["old"]));
    await post(call("getTransaction", ["new"]));
    clock.t += 60_000;
    expect((await post(call("getTransaction", ["old"]))).cache).to.equal("hit");
    expect((await post(call("getTransaction", ["new"]))).cache).to.equal("miss");
    await post(call("getBalance", ["owner"]));
    await post(call("getBalance", ["owner"]));
    expect(calls.map((c) => c.method)).to.deep.equal(["getTransaction", "getTransaction", "getTransaction", "getBalance", "getBalance"]);
  });

  it("never hands a caller the URL or the key behind it", async () => {
    let mode = "";
    const { post } = await serve(() => {
      if (mode === "throws") throw new Error(`request to ${KEYED} failed, reason: connect ECONNREFUSED`);
      if (mode === "429") return new Response("Too many requests for api-key relay-test-secret-0123456789", { status: 429 });
      if (mode === "huge") return new Response(`{"result":"${"x".repeat(1_000_001)}"}`);
      return { error: { code: -32602, message: `invalid params at ${KEYED}` } };
    });
    for (mode of ["throws", "429", "huge", "rpc error"]) {
      const res = await post(call("getSignaturesForAddress", [mode]));
      expect(res.status, mode).to.equal(mode === "rpc error" ? 200 : 502);
      expect(res.text, mode).not.to.contain("relay-test-secret");
      expect(res.text, mode).not.to.contain("api-key");
    }
  });

  it("spends no more than its budget upstream, then sends callers back to the public endpoint", async () => {
    const { post, calls, clock } = await serve(() => ({ result: [] }), { creditsPerMinute: 25, creditsPerDay: 40, callsPerSecond: 3, paceMs: 0 });
    expect((await post(scan(179))).status).to.equal(200); // ten credits
    expect((await post(scan(185))).status).to.equal(200); // twenty
    const over = await post(scan(73)); // thirty would pass the minute's 25
    expect(over.status).to.equal(429);
    expect(JSON.parse(over.text).error.code).to.equal(-32005);
    expect((await post(scan(179))).cache).to.equal("hit"); // what is kept is still served
    expect((await post(call("getBalance", ["a"]))).status).to.equal(200); // a one-credit read still fits
    expect((await post(call("getBalance", ["b"]))).status).to.equal(429); // a fourth call in one second does not
    clock.t += 1_000;
    expect((await post(call("getBalance", ["b"]))).status).to.equal(200); // 22 credits today
    clock.t += 60_000;
    expect((await post(scan(73))).status).to.equal(200); // a new minute: 32 today
    expect((await post(scan(89))).status).to.equal(429); // 42 would pass the day's 40
    expect(calls).to.have.length(5);
  });

  it("waits out a full second rather than refusing a page's burst", async () => {
    const { post, calls, clock } = await serve(() => balance, { creditsPerMinute: 1_000, creditsPerDay: 100_000, callsPerSecond: 2 });
    const burst = Promise.all(["a", "b", "c"].map((owner) => post(call("getBalance", [owner]))));
    await sleep(150);
    expect(calls).to.have.length(2); // the third waits for the next second
    clock.t += 1_000;
    expect((await burst).map((a) => a.status)).to.deep.equal([200, 200, 200]);
    expect(calls).to.have.length(3);
  });

  it("keeps an answer from when it was asked, so a slow read is gone by the page's second refresh", async () => {
    const slow = { clock: { t: 0 } };
    const { post, calls, clock } = await serve(() => {
      slow.clock.t += 3_000; // the upstream takes three seconds to answer
      return { result: [] };
    });
    slow.clock = clock;
    expect((await post(scan())).cache).to.equal("miss");
    clock.t += 2_500; // 5.5 s after it was asked, 2.5 s after it was answered
    expect((await post(scan())).cache).to.equal("miss");
    expect(calls).to.have.length(2);
  });

  it("gives web3.js its reads through the relay, and sends, blockhashes and anything unlisted past it", async () => {
    const account = {
      pubkey: Keypair.generate().publicKey.toBase58(),
      account: { data: [Buffer.alloc(179).toString("base64"), "base64"], executable: false, lamports: 1, owner: STOCKS_PROGRAM_ID.toBase58(), rentEpoch: 0, space: 179 },
    };
    const { url, calls } = await serve((method) => (method === "getProgramAccounts" ? { result: [account] } : balance));
    const publicCalls: string[] = [];
    const relayHeaders: unknown[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === url) {
        relayHeaders.push(init?.headers);
        return fetch(input, init);
      }
      const { id, method } = JSON.parse(String(init?.body)) as { id: string; method: string };
      publicCalls.push(method);
      const value = { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 9 }, value } }));
    }) as typeof fetch;
    const conn = new Connection("http://public-devnet.invalid", { commitment: "confirmed", fetch: relayingFetch(url, { fetchImpl }) });

    expect(await conn.getProgramAccounts(STOCKS_PROGRAM_ID, { filters: [{ dataSize: 179 }] })).to.have.length(1);
    expect(await conn.getBalance(Keypair.generate().publicKey)).to.equal(42);
    await conn.getLatestBlockhash("confirmed");
    expect(calls.map((c) => c.method)).to.deep.equal(["getProgramAccounts", "getBalance"]);
    expect(publicCalls).to.deep.equal(["getLatestBlockhash"]);
    // A simple request: nothing that would make a browser preflight each read.
    expect(relayHeaders).to.deep.equal([{ "content-type": "text/plain;charset=UTF-8" }, { "content-type": "text/plain;charset=UTF-8" }]);
  });

  it("falls back to the public endpoint when the relay is missing or down, then leaves it alone for a while", async () => {
    const RELAY = "http://relay.invalid/v1/solana/devnet";
    const clock = { t: 0 };
    let relay: "missing" | "down" | "up" = "missing";
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const where = String(input) === RELAY ? "relay" : "public";
      seen.push(where);
      if (where === "relay" && relay === "down") throw new TypeError("fetch failed");
      if (where === "relay" && relay === "missing") return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...balance }));
    }) as typeof fetch;
    const relayed = relayingFetch(RELAY, { fetchImpl, now: () => clock.t, restMs: 30_000 });
    const ask = (method: string) => relayed("http://public-devnet.invalid", { method: "POST", body: JSON.stringify(call(method, ["a"])) });

    expect((await ask("getBalance")).ok).to.equal(true);
    await ask("getBalance"); // resting: straight to the public endpoint
    clock.t += 30_000;
    relay = "down";
    await ask("getBalance");
    clock.t += 30_000;
    relay = "up";
    await ask("getBalance");
    await ask("sendTransaction"); // a write never takes the detour
    expect(seen).to.deep.equal(["relay", "public", "public", "relay", "public", "relay", "public"]);
  });
});
