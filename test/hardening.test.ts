import { expect } from "chai";
import express, { type Express } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { concurrencyLimit, hardenApp, mountErrorHandlers, rateLimit } from "../services/hardening";

/**
 * Everything here runs against a real Express app on a real socket. The
 * behaviours under test (trust proxy, header removal, the default error page,
 * a socket closing mid-request) live in Express and node:http, so a faked
 * req/res would only prove that the fake agrees with itself.
 */
describe("hardening a public Express service", () => {
  const servers: Server[] = [];

  /** Build an app, put it on an ephemeral loopback port, and return its base URL. */
  const serve = async (build: (app: Express) => void): Promise<string> => {
    const app = express();
    build(app);
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  /**
   * The test process IS loopback, and loopback with no forwarding header is
   * exempt from the limiter. To be counted, a request has to look like it came
   * through the host's load balancer, which is what production traffic does.
   */
  const as = (client: string): RequestInit => ({ headers: { "x-forwarded-for": client } });

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** Poll until `probe` is true; a slot freed by a socket closing is freed a tick later, not synchronously. */
  const eventually = async (probe: () => Promise<boolean>, timeoutMs = 2_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await probe()) return true;
      await sleep(20);
    }
    return false;
  };

  afterEach(async () => {
    // fetch keeps connections alive, and some tests leave a request hanging on
    // purpose; close() alone would wait for them and mocha would never exit.
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  describe("rateLimit", () => {
    const limited = (options: { limit: number; windowMs: number }) =>
      serve((app) => {
        hardenApp(app);
        app.use(rateLimit({ ...options, name: "quote" }));
        app.get("/ping", (_req, res) => res.json({ ok: true }));
      });

    it("answers 429 RATE_LIMITED with Retry-After and RateLimit-* headers once a client is over its budget", async () => {
      const base = await limited({ limit: 2, windowMs: 60_000 });

      const first = await fetch(`${base}/ping`, as("203.0.113.7"));
      expect(first.status).to.equal(200);
      // Allowed responses carry the budget too, so a well-behaved agent can pace itself before it is refused.
      expect(first.headers.get("ratelimit-limit")).to.equal("2");
      expect(first.headers.get("ratelimit-remaining")).to.equal("1");
      expect(first.headers.get("retry-after")).to.equal(null);

      const second = await fetch(`${base}/ping`, as("203.0.113.7"));
      expect(second.status).to.equal(200);
      expect(second.headers.get("ratelimit-remaining")).to.equal("0");

      const third = await fetch(`${base}/ping`, as("203.0.113.7"));
      expect(third.status).to.equal(429);
      expect(third.headers.get("content-type")).to.contain("application/json");
      expect(third.headers.get("ratelimit-limit")).to.equal("2");
      expect(third.headers.get("ratelimit-remaining")).to.equal("0");
      const retryAfter = Number(third.headers.get("retry-after"));
      expect(retryAfter).to.be.within(1, 60);
      expect(Number(third.headers.get("ratelimit-reset"))).to.equal(retryAfter);
      const body = (await third.json()) as { error: { code: string; message: string } };
      expect(body.error.code).to.equal("RATE_LIMITED");
      // The body names the budget that was spent, so a caller juggling several limits knows which one.
      expect(body.error.message).to.contain("quote");
    });

    it("keeps a separate budget for each forwarded client", async () => {
      const base = await limited({ limit: 1, windowMs: 60_000 });
      expect((await fetch(`${base}/ping`, as("203.0.113.7"))).status).to.equal(200);
      expect((await fetch(`${base}/ping`, as("203.0.113.7"))).status).to.equal(429);
      // One noisy agent must not lock every other agent out of the hub.
      const other = await fetch(`${base}/ping`, as("198.51.100.9"));
      expect(other.status).to.equal(200);
      expect(other.headers.get("ratelimit-remaining")).to.equal("0");
    });

    it("does not hand out a fresh budget to a caller who forges the left-hand side of X-Forwarded-For", async () => {
      // `trust proxy` is 1, not true: only the entry the load balancer itself
      // appended (the right-most) is believed. Everything to its left was typed
      // by the caller, and a caller who could pick their own bucket has no limit.
      const base = await limited({ limit: 1, windowMs: 60_000 });
      expect((await fetch(`${base}/ping`, as("10.0.0.1, 203.0.113.7"))).status).to.equal(200);
      expect((await fetch(`${base}/ping`, as("10.0.0.2, 203.0.113.7"))).status).to.equal(429);
    });

    it("lets the client back in once the window has passed", async () => {
      const base = await limited({ limit: 1, windowMs: 150 });
      expect((await fetch(`${base}/ping`, as("203.0.113.7"))).status).to.equal(200);
      expect((await fetch(`${base}/ping`, as("203.0.113.7"))).status).to.equal(429);
      await sleep(250);
      const after = await fetch(`${base}/ping`, as("203.0.113.7"));
      expect(after.status).to.equal(200);
      expect(after.headers.get("ratelimit-remaining")).to.equal("0");
    });

    it("never limits a loopback request that carries no forwarding header", async () => {
      // The MCP tools call the REST hub over loopback inside the same process.
      // Those calls were already counted at the edge; counting them again would
      // put every agent in one shared bucket and let one of them starve the rest.
      const base = await limited({ limit: 1, windowMs: 60_000 });
      for (let i = 0; i < 5; i += 1) {
        const response = await fetch(`${base}/ping`);
        expect(response.status).to.equal(200);
        expect(response.headers.get("ratelimit-limit")).to.equal(null);
      }
    });

    it("counts by the key it is given instead of the IP when one is supplied", async () => {
      const base = await serve((app) => {
        hardenApp(app);
        app.use(rateLimit({ limit: 1, windowMs: 60_000, name: "agent", key: (req) => String(req.headers["x-agent"]) }));
        app.get("/ping", (_req, res) => res.json({ ok: true }));
      });
      const call = (agent: string, client: string) =>
        fetch(`${base}/ping`, { headers: { "x-agent": agent, "x-forwarded-for": client } });
      expect((await call("alpha", "203.0.113.7")).status).to.equal(200);
      // Same agent key from a different address is still the same budget.
      expect((await call("alpha", "198.51.100.9")).status).to.equal(429);
      expect((await call("beta", "203.0.113.7")).status).to.equal(200);
    });
  });

  describe("concurrencyLimit", () => {
    /**
     * `/hold` parks its response until the test releases it, so "in flight" is
     * a state the test controls rather than a race it hopes to win. `/quick`
     * shares the same limiter and answers at once: it is the probe for whether
     * a slot is free.
     */
    const gated = async (max: number) => {
      const parked: Array<() => void> = [];
      let entered = 0;
      const base = await serve((app) => {
        hardenApp(app);
        app.use(concurrencyLimit(max, "mcp"));
        app.get("/hold", (_req, res) => {
          entered += 1;
          parked.push(() => res.json({ held: true }));
        });
        app.get("/quick", (_req, res) => res.json({ ok: true }));
      });
      return {
        base,
        /** Resolves once `count` requests are parked inside the handler, i.e. genuinely hold a slot. */
        holding: (count: number) => eventually(async () => entered >= count),
        releaseAll: () => parked.splice(0).forEach((finish) => finish()),
      };
    };

    it("answers 429 BUSY above the in-flight cap and frees the slot when a response finishes", async () => {
      const hub = await gated(2);
      const held = [fetch(`${hub.base}/hold`), fetch(`${hub.base}/hold`)];
      expect(await hub.holding(2)).to.equal(true);

      const refused = await fetch(`${hub.base}/quick`);
      expect(refused.status).to.equal(429);
      expect(refused.headers.get("retry-after")).to.equal("2");
      expect(refused.headers.get("content-type")).to.contain("application/json");
      const body = (await refused.json()) as { error: { code: string; message: string } };
      expect(body.error.code).to.equal("BUSY");
      expect(body.error.message).to.contain("mcp");

      hub.releaseAll();
      for (const response of await Promise.all(held)) {
        expect(response.status).to.equal(200);
        await response.json();
      }
      // A refusal must not itself hold a slot, and both finished responses must have given theirs back.
      const again = await Promise.all([fetch(`${hub.base}/quick`), fetch(`${hub.base}/quick`)]);
      expect(again.map((response) => response.status)).to.deep.equal([200, 200]);
    });

    it("frees the slot when the client disconnects before the response is written", async () => {
      // The leak that matters on a public hub: an agent opens a request, its
      // process dies, and `finish` never fires. If only `finish` released the
      // slot, a handful of dropped connections would wedge the endpoint at BUSY
      // until the instance restarted.
      const hub = await gated(1);
      const abort = new AbortController();
      const abandoned = fetch(`${hub.base}/hold`, { signal: abort.signal }).then(
        () => "answered",
        () => "aborted",
      );
      expect(await hub.holding(1)).to.equal(true);
      expect((await fetch(`${hub.base}/quick`)).status).to.equal(429);

      abort.abort();
      expect(await abandoned).to.equal("aborted");

      const freed = await eventually(async () => (await fetch(`${hub.base}/quick`)).status === 200);
      expect(freed, "the slot held by the disconnected client was never released").to.equal(true);
    });

    it("does not give a slot back twice when a response both finishes and closes", async () => {
      // Every completed response emits `finish` and then `close`. A release that
      // ran on both would drive the counter negative and quietly raise the cap.
      const hub = await gated(1);
      for (let i = 0; i < 3; i += 1) {
        const response = await fetch(`${hub.base}/quick`);
        expect(response.status).to.equal(200);
        await response.json();
      }
      const held = fetch(`${hub.base}/hold`);
      expect(await hub.holding(1)).to.equal(true);
      // With a double release the counter would sit at -2 here and this would be let through.
      expect((await fetch(`${hub.base}/quick`)).status).to.equal(429);
      hub.releaseAll();
      await (await held).json();
    });
  });

  describe("hardenApp", () => {
    it("removes X-Powered-By and sets nosniff and no-store on every response", async () => {
      const base = await serve((app) => {
        hardenApp(app);
        app.get("/ping", (_req, res) => res.json({ ok: true }));
      });
      const response = await fetch(`${base}/ping`);
      expect(response.status).to.equal(200);
      // Advertising the framework is a free fingerprint for whoever is scanning.
      expect(response.headers.get("x-powered-by")).to.equal(null);
      expect(response.headers.get("x-content-type-options")).to.equal("nosniff");
      // Quotes, balances and order states are per-agent and stale within seconds; no intermediary may keep them.
      expect(response.headers.get("cache-control")).to.equal("no-store");
      expect(response.headers.get("referrer-policy")).to.equal("no-referrer");
    });

    it("an unhardened app does advertise Express, which is what the call is there to stop", async () => {
      // Guards the test above against passing for the wrong reason (e.g. fetch hiding the header).
      const base = await serve((app) => {
        app.get("/ping", (_req, res) => res.json({ ok: true }));
      });
      const response = await fetch(`${base}/ping`);
      expect(response.headers.get("x-powered-by")).to.equal("Express");
      expect(response.headers.get("x-content-type-options")).to.equal(null);
    });

    it("puts the same headers on refusals, not only on successes", async () => {
      const base = await serve((app) => {
        hardenApp(app);
        app.use(rateLimit({ limit: 0, windowMs: 60_000, name: "closed" }));
        app.get("/ping", (_req, res) => res.json({ ok: true }));
      });
      const response = await fetch(`${base}/ping`, as("203.0.113.7"));
      expect(response.status).to.equal(429);
      expect(response.headers.get("x-content-type-options")).to.equal("nosniff");
      expect(response.headers.get("cache-control")).to.equal("no-store");
      expect(response.headers.get("x-powered-by")).to.equal(null);
    });
  });

  describe("mountErrorHandlers", () => {
    /** The kind of message an RPC client really throws: the URL it was calling, key and all. */
    const SECRET = "hk_live_9f3c2a7d51e84b6c";
    const LEAKY = `failed to get recent blockhash: fetch https://mainnet.helius-rpc.com/v0/rpc?api-key=${SECRET} failed: 503`;

    const app = () =>
      serve((instance) => {
        hardenApp(instance);
        instance.use(express.json());
        instance.post("/echo", (req, res) => res.json({ got: req.body }));
        instance.get("/throws", () => {
          throw new Error(LEAKY);
        });
        instance.get("/passes-error", (_req, _res, next) => next(new Error(LEAKY)));
        instance.get("/teapot", (_req, _res, next) => next(Object.assign(new Error(LEAKY), { status: 418 })));
        mountErrorHandlers(instance);
      });

    /** The 500 path logs on purpose; capture it so the run stays readable AND so the log line can be checked. */
    const withCapturedErrors = async <T>(run: () => Promise<T>): Promise<{ result: T; logged: string }> => {
      const original = console.error;
      const lines: string[] = [];
      console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
      try {
        return { result: await run(), logged: lines.join("\n") };
      } finally {
        console.error = original;
      }
    };

    it("answers an unknown route with a JSON 404, never Express's HTML page", async () => {
      const base = await app();
      for (const method of ["GET", "POST", "DELETE"]) {
        const response = await fetch(`${base}/v1/no-such-thing`, { method });
        expect(response.status).to.equal(404);
        expect(response.headers.get("content-type")).to.contain("application/json");
        const text = await response.text();
        // Express's own 404 echoes the method and path back inside <pre>; an agent parsing JSON chokes on it.
        expect(text).to.not.contain("<");
        expect(JSON.parse(text)).to.deep.equal({ error: { code: "NOT_FOUND", message: "no such route" } });
      }
    });

    it("answers malformed JSON with a 4xx JSON body instead of a 500 or a stack trace", async () => {
      const base = await app();
      const response = await fetch(`${base}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"symbol": "AAPLx", ',
      });
      // The caller's mistake, so the caller's status: a 500 here would page the operator for a typo.
      expect(response.status).to.equal(400);
      expect(response.headers.get("content-type")).to.contain("application/json");
      const text = await response.text();
      expect(text).to.not.contain("<");
      // body-parser's error carries a stack naming files on the host; none of it belongs in the answer.
      expect(text).to.not.contain("node_modules");
      expect(text).to.not.match(/\bat\s+\S+\s+\(/);
      const body = JSON.parse(text) as { error: { code: string; message: string } };
      expect(body.error.code).to.equal("INVALID_REQUEST");
      expect(body.error.message).to.be.a("string").with.length.within(1, 160);
    });

    it("still parses well-formed JSON, so the 400 above is about the body and not the route", async () => {
      const base = await app();
      const response = await fetch(`${base}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: "AAPLx" }),
      });
      expect(response.status).to.equal(200);
      expect(await response.json()).to.deep.equal({ got: { symbol: "AAPLx" } });
    });

    for (const route of ["/throws", "/passes-error"]) {
      it(`answers a generic 500 that does not carry the thrown message (${route})`, async () => {
        const base = await app();
        const { result, logged } = await withCapturedErrors(async () => {
          const response = await fetch(`${base}${route}`);
          return { response, text: await response.text() };
        });
        expect(result.response.status).to.equal(500);
        expect(result.response.headers.get("content-type")).to.contain("application/json");
        expect(JSON.parse(result.text)).to.deep.equal({ error: { code: "INTERNAL_ERROR", message: "internal error" } });
        // Belt and braces over the deep.equal: these are the specific things that must never leave the process.
        expect(result.text).to.not.contain(SECRET);
        expect(result.text).to.not.contain("api-key");
        expect(result.text).to.not.contain("helius");
        expect(result.text).to.not.contain("blockhash");
        expect(result.text).to.not.contain("<");

        // The operator does get told, but hosted logs are read by more people than hold the key.
        expect(logged).to.contain("blockhash");
        expect(logged).to.not.contain(SECRET);
      });
    }

    it("redacts the key even when the error is a client error whose message is shown", async () => {
      // 4xx messages ARE returned, because "what was wrong with my request" is
      // useful. That makes this the one path where upstream text reaches a
      // stranger, so it is the one that most needs the key taken out.
      const base = await app();
      const response = await fetch(`${base}/teapot`);
      expect(response.status).to.equal(418);
      const text = await response.text();
      expect(text).to.not.contain(SECRET);
      expect(text).to.not.contain("api-key");
      const body = JSON.parse(text) as { error: { code: string; message: string } };
      expect(body.error.code).to.equal("INVALID_REQUEST");
      expect(body.error.message).to.contain("https://mainnet.helius-rpc.com");
      expect(body.error.message.length).to.be.at.most(160);
    });
  });
});
