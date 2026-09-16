import { expect } from "chai";
import {
  PythProStockSource,
  PythStockGuard,
  VERIFIED_XSTOCKS,
  type PythMarketPolicy,
} from "../stocks";

describe("Pyth stock market guard — Day 3", () => {
  const nowMs = 1_800_000_000_000;
  const policy: PythMarketPolicy = {
    max_feed_age_seconds: 30,
    max_absolute_premium_bps: 300,
    max_confidence_bps: 100,
    min_publishers: 2,
  };

  it("compares different feed exponents and retains signed Solana evidence", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let authorization: string | null = null;
    const source = new PythProStockSource({
      apiKey: "test-pyth-key",
      fetch: async (_url, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        requestBody = JSON.parse(String(init?.body));
        return Response.json(update());
      },
    });
    const mutablePolicy = { ...policy };
    let clock = nowMs;
    const guard = new PythStockGuard(source, mutablePolicy, () => clock);
    const assessment = await guard.assess(VERIFIED_XSTOCKS[0]);
    mutablePolicy.max_absolute_premium_bps = 0;

    expect(requestBody?.priceFeedIds).to.deep.equal([922, 1792]);
    expect(requestBody?.formats).to.deep.equal(["solana"]);
    expect(authorization).to.equal("Bearer test-pyth-key");
    expect(assessment.allowed).to.equal(true);
    expect(assessment.premium_bps).to.equal(-50);
    expect(assessment.feeds.underlying.symbol).to.equal("Equity.US.AAPL/USD");
    expect(assessment.feeds.tokenized.symbol).to.equal("Crypto.AAPLX/USD");
    expect(assessment.solana_payload_hash).to.match(/^[0-9a-f]{64}$/);
    expect(assessment.evidence_hash).to.match(/^[0-9a-f]{64}$/);
    expect(guard.revalidate(assessment).allowed).to.equal(true);
    clock += 31_000;
    expect(guard.revalidate(assessment).refusal?.code).to.equal("PYTH_PRICE_STALE");
  });

  it("refuses stale, uncertain and dislocated markets with explicit reasons", async () => {
    const stale = await guard(update({ underlyingAgeMs: 31_000 })).assess(VERIFIED_XSTOCKS[0]);
    expect(stale.refusal?.code).to.equal("PYTH_PRICE_STALE");

    const uncertain = await guard(update({ tokenConfidence: "300000000" })).assess(VERIFIED_XSTOCKS[0]);
    expect(uncertain.refusal?.code).to.equal("PYTH_CONFIDENCE_WIDE");

    const thin = await guard(update({ tokenPublishers: 1 })).assess(VERIFIED_XSTOCKS[0]);
    expect(thin.refusal?.code).to.equal("PYTH_PUBLISHERS_LOW");

    const dislocated = await guard(update({ tokenPrice: "21000000000" })).assess(VERIFIED_XSTOCKS[0]);
    expect(dislocated.premium_bps).to.equal(500);
    expect(dislocated.refusal?.code).to.equal("PYTH_PRICE_DISLOCATION");

    const fractionalDislocation = await guard(update({ tokenPrice: "20601980000" })).assess(VERIFIED_XSTOCKS[0]);
    expect(fractionalDislocation.premium_bps).to.equal(300.99);
    expect(fractionalDislocation.refusal?.code).to.equal("PYTH_PRICE_DISLOCATION");

    const fractionalUncertainty = await guard(update({
      tokenPrice: "20000000000",
      tokenConfidence: "201980000",
    })).assess(VERIFIED_XSTOCKS[0]);
    expect(fractionalUncertainty.feeds.tokenized.confidence_bps).to.equal(100.99);
    expect(fractionalUncertainty.refusal?.code).to.equal("PYTH_CONFIDENCE_WIDE");
  });

  it("fails closed when Pyth omits either side of the comparison", async () => {
    const body = update();
    body.parsed.priceFeeds.pop();
    await expect(guard(body).assess(VERIFIED_XSTOCKS[0])).to.be.rejectedWith("Pyth response omitted Crypto.AAPLX/USD");
  });

  function guard(body: ReturnType<typeof update>) {
    const source = new PythProStockSource({
      apiKey: "test-pyth-key",
      fetch: async () => Response.json(body),
    });
    return new PythStockGuard(source, policy, () => nowMs);
  }

  function update(overrides: {
    underlyingAgeMs?: number;
    tokenPrice?: string;
    tokenConfidence?: string;
    tokenPublishers?: number;
  } = {}) {
    const timestampUs = BigInt(nowMs) * 1000n;
    return {
      type: "streamUpdated",
      parsed: {
        timestampUs: timestampUs.toString(),
        priceFeeds: [
          {
            priceFeedId: 922,
            price: "20000000",
            publisherCount: 4,
            exponent: -5,
            confidence: "1000",
            marketSession: "regular",
            feedUpdateTimestamp: (timestampUs - BigInt(overrides.underlyingAgeMs ?? 500) * 1000n).toString(),
          },
          {
            priceFeedId: 1792,
            price: overrides.tokenPrice ?? "19900000000",
            publisherCount: overrides.tokenPublishers ?? 5,
            exponent: -8,
            confidence: overrides.tokenConfidence ?? "1000000",
            marketSession: "regular",
            feedUpdateTimestamp: (timestampUs - 400_000n).toString(),
          },
        ],
      },
      solana: { encoding: "hex", data: "deadbeef" },
    };
  }
});
