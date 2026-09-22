import { expect } from "chai";
import {
  registerVenue,
  SOLANA_USDC_MINT,
  StockGovernor,
  StockPlatform,
  StockPlatformError,
  VERIFIED_XSTOCKS,
  type JupiterQuoteFetcher,
  type StockChainExecutor,
  type StockInstrument,
  type StockOrderRequest,
  type StockPlatformConfig,
} from "../stocks";

/**
 * The limits a public hub needs that the USDC caps do not give it.
 *
 * The governor bounds how much an agent may spend. None of that bounds how
 * *often* a stranger can make the hub do work: quotes are anonymous, the
 * catalogue is anonymous, and every executed trade costs the fee payer rent.
 * These tests drive `StockPlatform` directly, with a clock they own, so each
 * limit is observed at the exact second it starts and stops applying.
 */
describe("Quaestor Stocks platform — public-exposure limits", () => {
  /** 2023-11-14T22:13:20Z: late enough in a UTC day that two hours crosses midnight. */
  const START = 1_700_000_000;
  const QUOTE_LIFETIME = 30;
  /** `evictExpiredQuotes` keeps a dead quote this long so a late preview still gets a real answer. */
  const EVICTION_GRACE = 5;
  /** What this owner allows: the aggregator and the test venue, not "limits-unapproved". */
  const TEST_VENUE = "limits-test-venue";
  const TEST_PROGRAM = "QuaestorLimitsTestVenue111111111111111111";
  const APPROVED_VENUES = ["jupiter", TEST_VENUE];
  const AGENT = "limits-agent";
  const TOKEN = "limits-token-strong";
  const aapl = VERIFIED_XSTOCKS[0];

  let now: number;
  beforeEach(() => { now = START; });

  /** The same clock drives the governor, or an advanced platform would mint intents the governor thinks are from the future. */
  const governor = (operator: string) => {
    const instance = new StockGovernor({
      owner: `owner:${operator}`,
      operator,
      usdcMint: SOLANA_USDC_MINT,
      instruments: [...VERIFIED_XSTOCKS],
      policy: {
        perTradeCapUsdc: 60_000_000n,
        epochCapUsdc: 100_000_000n,
        epochLengthSeconds: 3600,
        approvedMints: new Set(VERIFIED_XSTOCKS.map((instrument) => instrument.mint)),
        approvedVenues: APPROVED_VENUES,
      },
      now: () => now,
    });
    instance.depositUsdc(`owner:${operator}`, 250_000_000n);
    return instance;
  };

  /** A quote source that counts how often it is asked: a refusal that still reached upstream has not saved the owner anything. */
  const quoteSource = (label = "src") => {
    const state = { calls: 0 };
    const source: JupiterQuoteFetcher = {
      quote: async (inputMint, outputMint, amount) => ({
        quoteId: `${label}-quote-${++state.calls}`,
        inputMint,
        outputMint,
        inAmount: amount,
        outAmount: amount * 2n,
        minimumOutput: (amount * 198n) / 100n,
        route: `${label} / test-liquidity`,
        expiresAt: now + QUOTE_LIFETIME,
      }),
    };
    return { source, state };
  };

  const countingExecutor = () => {
    const state = { calls: 0 };
    const executor: StockChainExecutor = {
      execute: async (_intent, quote) => {
        state.calls += 1;
        return { txSignature: `limits-tx-${state.calls}`, actualOutput: quote.outAmount, outcome: "settled" };
      },
    };
    return { executor, state };
  };

  const build = (overrides: Partial<StockPlatformConfig> = {}) => {
    const quotes = quoteSource();
    const chain = countingExecutor();
    const platform = new StockPlatform({
      instruments: VERIFIED_XSTOCKS,
      agents: [{
        agentId: AGENT,
        operator: "operator:limits",
        governor: governor("operator:limits"),
        credentials: [{ token: TOKEN, allowedMints: new Set([aapl.mint]) }],
      }],
      quotes: quotes.source,
      executor: chain.executor,
      now: () => now,
      ...overrides,
    });
    return { platform, quotes: quotes.state, executions: chain.state };
  };

  const makeOrder = (quoteId: string, intentId: string, agentId = AGENT): StockOrderRequest => ({
    agent_id: agentId,
    intent_id: intentId,
    quote_id: quoteId,
    intent_expires_at: new Date((now + 20) * 1000).toISOString(),
    decision: { strategy: "limits-test", rationale: "A deterministic test decision with enough context for a receipt." },
  });

  /** The platform's refusals are typed; a test that only matched the message would pass on the wrong refusal. */
  const refusalOf = async (work: () => unknown): Promise<StockPlatformError> => {
    let outcome: unknown;
    try {
      outcome = await work();
    } catch (error) {
      expect(error).to.be.instanceOf(StockPlatformError);
      return error as StockPlatformError;
    }
    throw new Error(`expected the platform to refuse, but it returned ${JSON.stringify(outcome)}`);
  };

  describe("the minimum trade", () => {
    it("refuses a quote one base unit below the default 1 USDC floor, without spending an upstream quote on it", async () => {
      const { platform, quotes } = build();
      const refused = await refusalOf(() => platform.createQuote(AGENT, aapl.mint, "999999"));
      expect(refused.code).to.equal("AMOUNT_TOO_SMALL");
      expect(refused.httpStatus).to.equal(400);
      // Dust is refused because it is cheap to send; paying for a quote first would defeat that.
      expect(quotes.calls).to.equal(0);
    });

    it("accepts a quote exactly at the default floor", async () => {
      const { platform } = build();
      const quote = await platform.createQuote(AGENT, aapl.mint, "1000000");
      expect(quote.amount_in_usdc).to.equal("1000000");
    });

    it("moves the floor with minTradeUsdc, so an owner with dearer rent can raise it", async () => {
      const { platform } = build({ minTradeUsdc: 5_000_000n });
      const refused = await refusalOf(() => platform.createQuote(AGENT, aapl.mint, "4999999"));
      expect(refused.code).to.equal("AMOUNT_TOO_SMALL");
      // The agent has to be able to correct itself from the refusal alone.
      expect(refused.message).to.include("5000000");
      expect((await platform.createQuote(AGENT, aapl.mint, "5000000")).amount_in_usdc).to.equal("5000000");
    });
  });

  describe("the quote store", () => {
    it("evicts expired quotes on the next quote, so an anonymous route cannot grow the store forever", async () => {
      const { platform } = build();
      const issued = [];
      for (let i = 0; i < 40; i += 1) issued.push(await platform.createQuote(AGENT, aapl.mint, "1000000"));
      const oldest = issued[0].quote_id;
      const newest = issued[issued.length - 1].quote_id;

      // Expired but still inside the grace window: the quote is dead to the
      // governor, yet still *known*, so the agent is told why rather than "not found".
      now = START + QUOTE_LIFETIME + EVICTION_GRACE;
      await platform.createQuote(AGENT, aapl.mint, "1000000");
      const stale = platform.preview(makeOrder(oldest, "stale-but-known"));
      expect(stale.allowed).to.equal(false);

      // One second past expiry + the grace, the next quote sweeps every one of them.
      now = START + QUOTE_LIFETIME + EVICTION_GRACE + 1;
      const fresh = await platform.createQuote(AGENT, aapl.mint, "1000000");
      for (const quoteId of [oldest, newest]) {
        const gone = await refusalOf(() => platform.preview(makeOrder(quoteId, `evicted-${quoteId}`)));
        expect(gone.code).to.equal("QUOTE_NOT_FOUND");
        expect(gone.httpStatus).to.equal(404);
      }
      // Eviction is by age, not a flush: the quote that triggered it survives.
      expect(platform.preview(makeOrder(fresh.quote_id, "fresh-intent")).allowed).to.equal(true);
    });

    it("refuses with QUOTE_CAPACITY (429) once maxLiveQuotes are held, and quotes again after they expire", async () => {
      const { platform, quotes } = build({ maxLiveQuotes: 3 });
      for (let i = 0; i < 3; i += 1) await platform.createQuote(AGENT, aapl.mint, "1000000");

      const full = await refusalOf(() => platform.createQuote(AGENT, aapl.mint, "1000000"));
      expect(full.code).to.equal("QUOTE_CAPACITY");
      expect(full.httpStatus).to.equal(429);
      // The cap exists to protect the upstream quota, so the refusal must come first.
      expect(quotes.calls).to.equal(3);

      // The same eviction that bounds memory is what frees capacity: no restart, no operator.
      now = START + QUOTE_LIFETIME + EVICTION_GRACE + 1;
      const again = await platform.createQuote(AGENT, aapl.mint, "1000000");
      expect(again.quote_id).to.equal("src-quote-4");
      // And it freed all three slots, not one.
      await platform.createQuote(AGENT, aapl.mint, "1000000");
      await platform.createQuote(AGENT, aapl.mint, "1000000");
      expect((await refusalOf(() => platform.createQuote(AGENT, aapl.mint, "1000000"))).code).to.equal("QUOTE_CAPACITY");
    });
  });

  describe("executions per UTC day", () => {
    it("refuses the (N+1)th distinct execution with EXECUTION_LIMIT (429) before the executor is reached", async () => {
      const { platform, executions } = build({ maxExecutionsPerDay: 2 });
      for (const intent of ["day-intent-1", "day-intent-2"]) {
        const quote = await platform.createQuote(AGENT, aapl.mint, "1000000");
        const order = await platform.execute(TOKEN, `key-${intent}`, makeOrder(quote.quote_id, intent));
        expect(order.status).to.equal("settled");
      }
      expect(executions.calls).to.equal(2);

      const quote = await platform.createQuote(AGENT, aapl.mint, "1000000");
      const limited = await refusalOf(() => platform.execute(TOKEN, "key-day-intent-3", makeOrder(quote.quote_id, "day-intent-3")));
      expect(limited.code).to.equal("EXECUTION_LIMIT");
      expect(limited.httpStatus).to.equal(429);
      // Every executor call is rent on the fee payer: the bound is only real if it holds before one.
      expect(executions.calls).to.equal(2);
    });

    it("does not charge a replay of an already-executed intent against the budget", async () => {
      const { platform, executions } = build({ maxExecutionsPerDay: 2 });
      const firstQuote = await platform.createQuote(AGENT, aapl.mint, "1000000");
      const request = makeOrder(firstQuote.quote_id, "replayed-intent");
      const first = await platform.execute(TOKEN, "replay-key-1", request);

      // A client that retries on a timeout is behaving correctly. Both replay
      // paths — same key, and same intent under a new key — must be free.
      for (let i = 0; i < 5; i += 1) {
        expect(await platform.execute(TOKEN, "replay-key-1", request)).to.deep.equal(first);
        expect(await platform.execute(TOKEN, `replay-key-other-${i}`, request)).to.deep.equal(first);
      }
      expect(executions.calls).to.equal(1);

      // Ten replays later the second slot of the day is still there...
      const secondQuote = await platform.createQuote(AGENT, aapl.mint, "1000000");
      const second = await platform.execute(TOKEN, "second-key-1", makeOrder(secondQuote.quote_id, "second-intent"));
      expect(second.status).to.equal("settled");
      // ...and only the third *distinct* execution is refused.
      const thirdQuote = await platform.createQuote(AGENT, aapl.mint, "1000000");
      const limited = await refusalOf(() => platform.execute(TOKEN, "third-key-1", makeOrder(thirdQuote.quote_id, "third-intent")));
      expect(limited.code).to.equal("EXECUTION_LIMIT");
      expect(executions.calls).to.equal(2);

      // Being out of budget must not take away the answer to a trade already made.
      expect(await platform.execute(TOKEN, "replay-key-1", request)).to.deep.equal(first);
    });

    it("resets the budget when the clock crosses into the next UTC day", async () => {
      const { platform, executions } = build({ maxExecutionsPerDay: 1 });
      const quote = await platform.createQuote(AGENT, aapl.mint, "1000000");
      expect((await platform.execute(TOKEN, "today-key-1", makeOrder(quote.quote_id, "today-intent"))).status).to.equal("settled");

      // One second before midnight UTC is still today.
      now = Math.floor(Date.parse("2023-11-14T23:59:59Z") / 1000);
      const lateQuote = await platform.createQuote(AGENT, aapl.mint, "1000000");
      const lateRequest = makeOrder(lateQuote.quote_id, "late-intent");
      const limited = await refusalOf(() => platform.execute(TOKEN, "late-key-1", lateRequest));
      expect(limited.code).to.equal("EXECUTION_LIMIT");

      // Midnight itself is tomorrow. The refused attempt recorded no order, so
      // the very same request and key go through once the day turns.
      now = Math.floor(Date.parse("2023-11-15T00:00:00Z") / 1000);
      const order = await platform.execute(TOKEN, "late-key-1", lateRequest);
      expect(order.status).to.equal("settled");
      expect(executions.calls).to.equal(2);

      // And the new day has its own limit rather than none.
      const nextQuote = await platform.createQuote(AGENT, aapl.mint, "1000000");
      expect((await refusalOf(() => platform.execute(TOKEN, "next-key-1", makeOrder(nextQuote.quote_id, "next-intent")))).code)
        .to.equal("EXECUTION_LIMIT");
    });
  });

  describe("the operator credential", () => {
    it("refuses a wrong token with 401 UNAUTHORIZED_OPERATOR even on the replay path of an order that exists", async () => {
      const otherToken = "other-token-strong";
      const { platform, executions } = build({
        agents: [
          {
            agentId: AGENT,
            operator: "operator:limits",
            governor: governor("operator:limits"),
            credentials: [{ token: TOKEN, allowedMints: new Set([aapl.mint]) }],
          },
          {
            agentId: "other-agent",
            operator: "operator:other",
            governor: governor("operator:other"),
            credentials: [{ token: otherToken, allowedMints: new Set([aapl.mint]) }],
          },
        ],
      });
      const quote = await platform.createQuote(AGENT, aapl.mint, "1000000");
      const request = makeOrder(quote.quote_id, "private-intent");
      const settled = await platform.execute(TOKEN, "private-key-1", request);
      expect(settled.status).to.equal("settled");

      // The replay paths return a stored order without running anything, which
      // is exactly why they must not be reachable without the credential: the
      // request body is guessable, and the order carries the decision record.
      const attempts: [string, string, string][] = [
        ["a made-up token on the same idempotency key", "stranger-token-xxxx", "private-key-1"],
        ["a made-up token on the same intent under a new key", "stranger-token-xxxx", "stranger-key-1"],
        ["an empty token", "", "private-key-1"],
        // A credential that is valid on this hub, but for a different agent.
        ["another agent's real token", otherToken, "private-key-1"],
      ];
      for (const [label, token, key] of attempts) {
        const refused = await refusalOf(() => platform.execute(token, key, request));
        expect(refused.code, label).to.equal("UNAUTHORIZED_OPERATOR");
        expect(refused.httpStatus, label).to.equal(401);
      }

      // A stranger gets the same answer for an intent that does not exist, so
      // the 401 cannot be used to probe which intents do.
      const unknown = await refusalOf(() =>
        platform.execute("stranger-token-xxxx", "stranger-key-2", makeOrder("no-such-quote", "no-such-intent")));
      expect(unknown.code).to.equal("UNAUTHORIZED_OPERATOR");
      expect(unknown.httpStatus).to.equal(401);

      // Nor to learn which agents exist: an agent id this hub has never heard
      // of gets the same 401 as a wrong token for one it has.
      const noSuchAgent = await refusalOf(() =>
        platform.execute("stranger-token-xxxx", "stranger-key-3", { ...request, agent_id: "no-such-agent" }));
      expect(noSuchAgent.code).to.equal("UNAUTHORIZED_OPERATOR");
      expect(noSuchAgent.httpStatus).to.equal(401);

      expect(executions.calls).to.equal(1);
      // None of that disturbed the owner's own replay.
      expect(await platform.execute(TOKEN, "private-key-1", request)).to.deep.equal(settled);
    });
  });

  describe("the instrument catalogue", () => {
    const openAi: StockInstrument = {
      symbol: "OPENAI",
      name: "OpenAI",
      issuer: "PreStocks",
      provider: "prestocks",
      assetClass: "private-company-exposure",
      executionStatus: "discovery-only",
      mint: "11111111111111111111111111111111",
      usdcMint: SOLANA_USDC_MINT,
      decimals: 9,
      enabled: false,
      network: "solana-mainnet",
      rightsNotice: "Economic exposure only.",
    };

    /** Slow on purpose: concurrent callers must actually overlap the build to prove it is single-flight. */
    const countingSource = (provider = "prestocks") => {
      const state = { calls: 0 };
      return {
        state,
        source: {
          provider,
          instruments: async () => {
            state.calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 15));
            return [openAi];
          },
        },
      };
    };

    it("asks a dynamic source once for many concurrent and sequential calls, and again only after catalogTtlMs", async () => {
      const upstream = countingSource();
      const { platform } = build({ instrumentSources: [upstream.source], catalogTtlMs: 300_000 });

      // The route is anonymous: twenty strangers at once must cost one upstream call, not twenty.
      const concurrent = await Promise.all(Array.from({ length: 20 }, () => platform.catalog()));
      expect(upstream.state.calls).to.equal(1);
      for (const catalog of concurrent) {
        expect(catalog.instruments.map((instrument) => instrument.symbol)).to.include("OPENAI");
        expect(catalog.sources).to.deep.include({ provider: "prestocks", status: "ok", count: 1 });
      }

      for (let i = 0; i < 10; i += 1) await platform.catalog();
      expect(upstream.state.calls).to.equal(1);

      // A caller gets a copy: mutating it must not rewrite what the next stranger is served.
      concurrent[0].instruments.length = 0;
      concurrent[0].sources[0].status = "unavailable";
      const served = await platform.catalog();
      expect(served.instruments.map((instrument) => instrument.symbol)).to.include("OPENAI");
      expect(served.sources.every((source) => source.status === "ok")).to.equal(true);

      // A healthy catalogue outlives the 60s a degraded one gets...
      now = START + 61;
      await platform.catalog();
      // ...and is served up to the last second of its TTL.
      now = START + 299;
      await platform.catalog();
      expect(upstream.state.calls).to.equal(1);

      now = START + 300;
      const rebuilt = await platform.catalog();
      expect(upstream.state.calls).to.equal(2);
      expect(rebuilt.observed_at).to.equal(new Date((START + 300) * 1000).toISOString());
    });

    it("caches a degraded catalogue for about a minute: long enough not to hammer what is down, short enough not to pin the failure", async () => {
      const healthy = countingSource();
      const broken = { calls: 0, down: true };
      const { platform } = build({
        catalogTtlMs: 600_000,
        instrumentSources: [
          healthy.source,
          {
            provider: "flaky-provider",
            instruments: async () => {
              broken.calls += 1;
              if (broken.down) throw new Error("provider timed out");
              return [];
            },
          },
        ],
      });

      const degraded = await platform.catalog();
      expect(degraded.sources).to.deep.include({ provider: "flaky-provider", status: "unavailable", count: 0, error: "provider timed out" });
      // One source failing does not take the others' instruments down with it.
      expect(degraded.instruments.map((instrument) => instrument.symbol)).to.include("OPENAI");

      // Within the minute the failure is served from cache, so a provider that is down is not hit per request.
      now = START + 59;
      await Promise.all(Array.from({ length: 10 }, () => platform.catalog()));
      expect(broken.calls).to.equal(1);
      expect(healthy.state.calls).to.equal(1);

      // After it, the failure is measured again rather than pinned for the full ten-minute TTL.
      broken.down = false;
      now = START + 61;
      const recovered = await platform.catalog();
      expect(broken.calls).to.equal(2);
      expect(recovered.sources).to.deep.include({ provider: "flaky-provider", status: "ok", count: 0 });

      // Now healthy, it earns the long TTL: two more minutes do not rebuild it.
      now = START + 61 + 120;
      await platform.catalog();
      expect(broken.calls).to.equal(2);
      expect(healthy.state.calls).to.equal(2);
    });
  });

  describe("the default venue", () => {

    before(() => {
      // The registry is process-wide, so the id and program are unique to this file.
      registerVenue({
        id: TEST_VENUE,
        label: "limits-test",
        programId: TEST_PROGRAM,
        kind: "test",
        verifiedOn: "2026-09-19",
      });
    });

    it("sends a quote that names no venue to the deployment's default, and lists that venue instead of Jupiter", async () => {
      const venueSource = quoteSource("venue");
      const { platform, quotes: jupiter } = build({
        defaultVenue: TEST_VENUE,
        venueQuotes: { [TEST_VENUE]: venueSource.source },
      });

      const quote = await platform.createQuote(AGENT, aapl.mint, "1000000");
      // On devnet the aggregator has no route for a test mint: a default that
      // went there would fail every time and spend upstream quota doing it.
      expect(venueSource.state.calls).to.equal(1);
      expect(jupiter.calls).to.equal(0);
      expect(quote.venue).to.equal(TEST_VENUE);
      expect(quote.quote_id).to.equal("venue-quote-1");

      const listed = platform.venues();
      expect(listed).to.deep.equal([{ id: TEST_VENUE, label: "limits-test", program_id: TEST_PROGRAM, kind: "test" }]);
      expect(listed.map((venue) => venue.id)).to.not.include("jupiter");
    });

    it("still defaults to Jupiter when the deployment names no default", async () => {
      const venueSource = quoteSource("venue");
      const { platform, quotes: jupiter } = build({ venueQuotes: { [TEST_VENUE]: venueSource.source } });
      const quote = await platform.createQuote(AGENT, aapl.mint, "1000000");
      expect(quote.venue).to.equal("jupiter");
      expect(jupiter.calls).to.equal(1);
      expect(venueSource.state.calls).to.equal(0);
      expect(platform.venues().map((venue) => venue.id)).to.have.members(["jupiter", TEST_VENUE]);
    });
  });

  describe("a venue the owner has not approved", () => {
    it("is refused before its source is asked, so a stranger cannot spend the owner's upstream quota on it", async () => {
      const unapproved = quoteSource("unapproved");
      registerVenue({ id: "limits-unapproved", label: "limits-unappr", programId: TEST_PROGRAM, kind: "test", verifiedOn: "2026-09-19" });
      const { platform } = build({ venueQuotes: { "limits-unapproved": unapproved.source } });
      const refusal = await refusalOf(() => platform.createQuote(AGENT, aapl.mint, "1000000", "limits-unapproved"));
      expect(refusal.code).to.equal("UNAPPROVED_VENUE");
      expect(refusal.httpStatus).to.equal(403);
      // The whole point: refused without the upstream call.
      expect(unapproved.state.calls).to.equal(0);
    });

    it("refuses to start with a default venue nobody can quote", () => {
      expect(() => build({ defaultVenue: TEST_VENUE })).to.throw("has no quote source configured");
    });
  });

  describe("one quote, one attempt", () => {
    it("refuses a second intent on a quote that was already executed", async () => {
      // Idempotency is keyed on the intent. An agent that times out and previews
      // the same quote again holds a second intent for it — and without this, a
      // second intent is a second trade.
      let executions = 0;
      const { platform } = build({
        executor: { execute: async (_intent, quote) => { executions += 1; return { txSignature: `sig-${executions}`, actualOutput: quote.outAmount, outcome: "settled" }; } },
      });
      const quote = await platform.createQuote(AGENT, aapl.mint, "1000000");
      const first = await platform.execute(TOKEN, "idem-first-0001", makeOrder(quote.quote_id, "intent-first-0001"));
      expect(first.status).to.equal("settled");

      const second = await refusalOf(() => platform.execute(TOKEN, "idem-second-0001", makeOrder(quote.quote_id, "intent-second-0001")));
      expect(second.code).to.equal("QUOTE_ALREADY_USED");
      expect(second.httpStatus).to.equal(409);
      expect(executions).to.equal(1);

      // The legitimate retry — the same intent — still returns the original order.
      const replay = await platform.execute(TOKEN, "idem-first-0001", makeOrder(quote.quote_id, "intent-first-0001"));
      expect(replay.order_id).to.equal(first.order_id);
      expect(executions).to.equal(1);
    });
  });

  describe("refusal messages on public order records", () => {
    const LEAKY = "https://rpc.example/?api-key=SECRET";

    it("never exposes an RPC URL's API key from an executor error, in the order execute() returns or the one order() serves", async () => {
      const { platform } = build({
        executor: {
          // What a real RPC client does: it names the URL it was calling, key and all.
          execute: async () => { throw new Error(`failed to send transaction: POST ${LEAKY} returned 503`); },
        },
      });
      const quote = await platform.createQuote(AGENT, aapl.mint, "1000000");
      const request = makeOrder(quote.quote_id, "leaky-intent");
      const returned = await platform.execute(TOKEN, "leaky-key-1", request);

      // The executor threw after the reservation, so the truth is "unknown", not "failed".
      expect(returned.status).to.equal("pending_reconciliation");
      expect(returned.refusal?.code).to.equal("EXECUTION_UNRESOLVED");
      // Redaction keeps what helps an operator debug — which host, what happened — and drops the key.
      expect(returned.refusal?.message).to.include("https://rpc.example");
      expect(returned.refusal?.message).to.include("returned 503");

      // order() needs no credential at all, and a replay re-serves the stored
      // record: the secret has to be gone from what is *stored*, not from one view of it.
      const views = [returned, platform.order(returned.order_id), await platform.execute(TOKEN, "leaky-key-1", request)];
      for (const view of views) {
        expect(JSON.stringify(view)).to.not.include("SECRET");
        expect(JSON.stringify(view)).to.not.include("api-key=");
      }
    });
  });
});
