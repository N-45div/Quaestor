import { expect } from "chai";
import { ethers } from "ethers";
import { ledgerPublisher } from "../services/stocks";
import { SOLANA_USDC_MINT, StockGovernor, StockPlatform, VERIFIED_XSTOCKS, type JupiterQuoteFetcher, type StockChainExecutor } from "../stocks";

describe("Quaestor Stocks — publishing decision records", () => {
  const nowSeconds = 1_700_000_000;
  const aapl = VERIFIED_XSTOCKS[0];
  const quotes: JupiterQuoteFetcher = {
    quote: async (inputMint, outputMint, amount) => ({
      quoteId: `quote-${outputMint}-${amount}`,
      inputMint,
      outputMint,
      inAmount: amount,
      outAmount: amount * 2n,
      minimumOutput: (amount * 198n) / 100n,
      route: "test-liquidity",
      expiresAt: nowSeconds + 30,
    }),
  };
  const settles: StockChainExecutor = { execute: async (_i, q) => ({ txSignature: "sig", actualOutput: q.outAmount, outcome: "settled" }) };

  const build = (publishRecord: (r: { raw: string; hash: string }) => Promise<void>, perTradeCapUsdc = 60_000_000n) => {
    const governor = new StockGovernor({
      owner: "owner:records",
      operator: "operator:records",
      usdcMint: SOLANA_USDC_MINT,
      instruments: [...VERIFIED_XSTOCKS],
      policy: { perTradeCapUsdc, epochCapUsdc: 100_000_000n, epochLengthSeconds: 3600, approvedMints: new Set([aapl.mint]) },
      now: () => nowSeconds,
    });
    governor.depositUsdc("owner:records", 250_000_000n);
    return new StockPlatform({
      instruments: VERIFIED_XSTOCKS,
      agents: [{ agentId: "records-agent", operator: "operator:records", governor, credentials: [{ token: "records-token-strong", allowedMints: new Set([aapl.mint]) }] }],
      quotes,
      executor: settles,
      publishRecord,
      now: () => nowSeconds,
    });
  };

  const order = async (platform: StockPlatform, intentId: string, usdc = "5000000") => {
    const quote = await platform.createQuote("records-agent", aapl.mint, usdc);
    return platform.execute("records-token-strong", `key-${intentId}`, {
      agent_id: "records-agent",
      intent_id: intentId,
      quote_id: quote.quote_id,
      intent_expires_at: new Date((nowSeconds + 20) * 1000).toISOString(),
      decision: { strategy: "records-test", rationale: "Buy a small position to check that the record is published as committed." },
    });
  };

  it("publishes the exact bytes a settled trade committed to", async () => {
    const published: { raw: string; hash: string }[] = [];
    const settled = await order(build(async (r) => { published.push(r); }), "intent-published");
    expect(settled.status).to.equal("settled");
    expect(published).to.have.length(1);
    // The ledger addresses a record by its keccak256; these bytes must hash to what the chain holds.
    expect(ethers.keccak256(ethers.toUtf8Bytes(published[0].raw))).to.equal(settled.decision_record_hash);
    expect(published[0].hash).to.equal(settled.decision_record_hash);
    expect(published[0].raw).to.equal(JSON.stringify(settled.decision_record));
  });

  it("publishes nothing for a refused trade", async () => {
    const published: unknown[] = [];
    const refused = await order(build(async (r) => { published.push(r); }, 1_000_000n), "intent-refused").catch((e) => e);
    expect(refused?.status ?? refused?.code).to.not.equal("settled");
    expect(published).to.have.length(0);
  });

  it("keeps a settled trade settled when the ledger is down", async () => {
    const settled = await order(build(async () => { throw new Error("ledger unreachable"); }), "intent-ledger-down");
    expect(settled.status).to.equal("settled");
  });

  it("refuses a ledger that stored the record under another hash", async () => {
    const raw = JSON.stringify({ action: "buy" });
    const hash = ethers.keccak256(ethers.toUtf8Bytes(raw));
    const answering = (metaHash: string, status = 200) =>
      (async () => new Response(JSON.stringify({ metaHash }), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await ledgerPublisher("https://ledger.test/", answering(hash))({ raw, hash });
    const wrong = await ledgerPublisher("https://ledger.test", answering(ethers.ZeroHash))({ raw, hash }).then(() => null, (e: Error) => e.message);
    expect(wrong).to.contain("not " + hash);
    const down = await ledgerPublisher("https://ledger.test", answering(hash, 503))({ raw, hash }).then(() => null, (e: Error) => e.message);
    expect(down).to.contain("503");
  });
});

describe("Quaestor Stocks — the refusal demonstration", () => {
  const base = { instruments: VERIFIED_XSTOCKS, agents: [], quotes: { quote: async () => { throw new Error("unused"); } }, executor: { execute: async () => { throw new Error("unused"); } } };

  it("answers 503 on a deployment with nothing to demonstrate on", async () => {
    const error = await new StockPlatform(base as never).refusalDemo("short").then(() => null, (e) => e);
    expect(error?.code).to.equal("DEMO_UNAVAILABLE");
    expect(error?.httpStatus).to.equal(503);
  });

  it("sends only the two refusals it knows, and nothing it was not asked for", async () => {
    const asked: string[] = [];
    const platform = new StockPlatform({ ...base, refusalDemo: async (kind) => { asked.push(kind); return { kind } as never; } } as never);
    const bad = await platform.refusalDemo("settle-for-real").then(() => null, (e) => e);
    expect(bad?.code).to.equal("INVALID_REQUEST");
    await platform.refusalDemo("short");
    await platform.refusalDemo("over-cap");
    expect(asked).to.deep.equal(["short", "over-cap"]);
  });
});
