import { expect } from "chai";
import {
  BackpackIndexSource,
  GeckoTerminalHistorySource,
  JupiterPriceSource,
  parseWindow,
  PriceSampler,
  PriceTape,
  sparkline,
  summarize,
  usEquitySession,
  type StockInstrument,
} from "../stocks";

const NOW = 1_789_720_000; // Fri 18 Sep 2026, 08:26 UTC
const AAPL = { symbol: "AAPLx", mint: "AAPL_MINT", underlyingSymbol: "AAPL" };

/** Build a tape whose clock is pinned, so windows and ages are exact. */
const tapeAt = (now = NOW) => new PriceTape({ now: () => now });

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("stock price tape", () => {
  describe("tape", () => {
    it("merges out-of-order points and collapses duplicates at the same second", () => {
      const tape = tapeAt();
      tape.record(AAPL.mint, "tokenized", { t: NOW - 60, price: 2, source: "a" }, { t: NOW - 120, price: 1, source: "a" });
      tape.record(AAPL.mint, "tokenized", { t: NOW - 60, price: 3, source: "b" });
      const series = tape.series(AAPL.mint, "tokenized");
      expect(series.map((p) => p.t)).to.deep.equal([NOW - 120, NOW - 60]);
      // The later write for the same instant wins, so a live sample and a
      // backfilled candle never count twice.
      expect(series[1]).to.include({ price: 3, source: "b" });
    });

    it("drops points older than its horizon and bad prices", () => {
      const tape = new PriceTape({ now: () => NOW, maxAgeSeconds: 3_600 });
      tape.record(AAPL.mint, "reference",
        { t: NOW - 7_200, price: 1, source: "x" },
        { t: NOW - 60, price: 0, source: "x" },
        { t: NOW - 30, price: Number.NaN, source: "x" },
        { t: NOW - 10, price: 5, source: "x" });
      expect(tape.series(AAPL.mint, "reference").map((p) => p.price)).to.deep.equal([5]);
    });

    it("never grows past its cap", () => {
      const tape = new PriceTape({ now: () => NOW, maxPoints: 3 });
      for (let i = 10; i > 0; i -= 1) tape.record(AAPL.mint, "tokenized", { t: NOW - i, price: i, source: "x" });
      expect(tape.series(AAPL.mint, "tokenized")).to.have.length(3);
      expect(tape.latest(AAPL.mint, "tokenized")?.t).to.equal(NOW - 1);
    });

    it("carries the last known price forward, as a market price does", () => {
      const tape = tapeAt();
      tape.record(AAPL.mint, "tokenized", { t: NOW - 300, price: 10, source: "x" });
      expect(tape.at(AAPL.mint, "tokenized", NOW)?.price).to.equal(10);
      expect(tape.at(AAPL.mint, "tokenized", NOW - 301)).to.equal(undefined);
    });
  });

  describe("session clock", () => {
    // New York is UTC-4 in September and UTC-5 in December; the clock has to
    // follow daylight saving rather than a fixed offset.
    const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

    it("follows the New York clock through daylight saving", () => {
      expect(usEquitySession(at("2026-09-18T14:00:00Z"))).to.equal("regular"); // 10:00 EDT
      expect(usEquitySession(at("2026-12-18T14:00:00Z"))).to.equal("pre-market"); // 09:00 EST
      expect(usEquitySession(at("2026-12-18T15:00:00Z"))).to.equal("regular"); // 10:00 EST
    });

    it("names every session", () => {
      expect(usEquitySession(at("2026-09-18T09:00:00Z"))).to.equal("pre-market"); // 05:00
      expect(usEquitySession(at("2026-09-18T21:00:00Z"))).to.equal("after-hours"); // 17:00
      expect(usEquitySession(at("2026-09-18T02:00:00Z"))).to.equal("overnight"); // Thu 22:00
      expect(usEquitySession(at("2026-09-19T16:00:00Z"))).to.equal("weekend"); // Sat 12:00
    });
  });

  describe("summary", () => {
    const withGap = (startBps: number, endBps: number) => {
      const tape = tapeAt();
      for (let i = 0; i <= 60; i += 1) {
        const t = NOW - 3_600 + i * 60;
        const bpsNow = startBps + ((endBps - startBps) * i) / 60;
        tape.record(AAPL.mint, "reference", { t, price: 100, source: "ref" });
        tape.record(AAPL.mint, "tokenized", { t, price: 100 * (1 + bpsNow / 10_000), source: "tok" });
      }
      return summarize(tape, AAPL, { windowSeconds: 3_600, buckets: 12, now: NOW });
    };

    it("measures the premium in basis points of the reference, with its sign", () => {
      expect(withGap(-80, -80).premium).to.include({ now_bps: -80, trend: "stable" });
      expect(withGap(50, 50).premium).to.include({ now_bps: 50 });
    });

    it("calls a gap widening or narrowing only past a threshold", () => {
      expect(withGap(10, 120).premium?.trend).to.equal("widening");
      expect(withGap(120, 10).premium?.trend).to.equal("narrowing");
      // Crossing zero is judged by distance from parity, not by sign.
      expect(withGap(-100, 5).premium?.trend).to.equal("narrowing");
    });

    it("writes a narrative that states only what the figures show", () => {
      const s = withGap(10, 120);
      expect(s.narrative).to.contain("AAPLx");
      expect(s.narrative).to.contain("120 bps above its reference");
      expect(s.narrative).to.contain("widening");
      expect(s.series).to.have.length(12);
      expect(s.sparkline.premium).to.have.length(12);
    });

    it("says level rather than '0 bps above'", () => {
      expect(withGap(0, 0).narrative).to.contain("level with its reference");
    });

    it("reports a missing side instead of inventing one", () => {
      const tape = tapeAt();
      tape.record(AAPL.mint, "tokenized", { t: NOW - 60, price: 100, source: "tok" });
      const s = summarize(tape, AAPL, { windowSeconds: 3_600, now: NOW });
      expect(s.reference).to.equal(null);
      expect(s.premium).to.equal(null);
      expect(s.narrative).to.contain("No reference price");
    });

    it("leaves a gap rather than comparing a stale trade with a live reference", () => {
      const tape = tapeAt();
      // One token trade an hour ago at a 2% premium, then nothing; the
      // reference keeps ticking every minute.
      tape.record(AAPL.mint, "tokenized", { t: NOW - 3_600, price: 102, source: "tok" });
      for (let i = 0; i <= 60; i += 1) tape.record(AAPL.mint, "reference", { t: NOW - 3_600 + i * 60, price: 100, source: "ref" });
      const s = summarize(tape, AAPL, { windowSeconds: 3_600, buckets: 12, now: NOW, maxCarrySeconds: 900 });
      // Only buckets within 15 minutes of that trade may price it.
      const priced = s.series.filter((b) => b.premium_bps !== undefined);
      expect(priced.length).to.be.greaterThan(0);
      expect(priced.every((b) => b.t - (NOW - 3_600) <= 900)).to.equal(true);
      expect(s.series.at(-1)?.premium_bps).to.equal(undefined);
    });

    it("flags a stale price", () => {
      const tape = tapeAt();
      tape.record(AAPL.mint, "tokenized", { t: NOW - 1_800, price: 100, source: "tok" });
      expect(summarize(tape, AAPL, { windowSeconds: 3_600, now: NOW }).narrative).to.contain("30 minutes old");
    });

    it("draws a sparkline the width of its input, blank where there is no price", () => {
      expect(sparkline([1, 2, 3, Number.NaN, 5])).to.equal("▁▃▅ █");
      expect(sparkline([4, 4, 4])).to.equal("▄▄▄");
    });
  });

  describe("windows", () => {
    it("accepts minutes, hours and days inside the tape's horizon", () => {
      expect(parseWindow("15m")).to.equal(900);
      expect(parseWindow("6h")).to.equal(21_600);
      expect(parseWindow("1d")).to.equal(86_400);
    });

    it("refuses what the tape cannot honestly answer", () => {
      expect(() => parseWindow("2d")).to.throw("between 5m and 24h");
      expect(() => parseWindow("1m")).to.throw("between 5m and 24h");
      expect(() => parseWindow("an hour")).to.throw("15m, 1h or 1d");
    });
  });

  describe("sources", () => {
    const instrument = { ...AAPL, issuer: "x", usdcMint: "USDC", decimals: 8, enabled: true } as StockInstrument;

    it("reads Backpack's index price, not its perp trades, live and historical", async () => {
      const seen: string[] = [];
      const fetchStub = (async (url: string) => {
        seen.push(String(url));
        if (String(url).includes("markPrices")) {
          return jsonResponse([
            { symbol: "AAPL.US_USDC_PERP", indexPrice: "337.185", markPrice: "337.18" },
            { symbol: "BTC_USDC_PERP", indexPrice: "1", markPrice: "1" },
          ]);
        }
        return jsonResponse([{ end: "2026-09-18 06:59:00", close: "337.19" }]);
      }) as typeof fetch;
      const source = new BackpackIndexSource("https://bp.test", fetchStub);

      const live = await source.sample([instrument]);
      expect(live).to.have.length(1);
      expect(live[0].point.price).to.equal(337.185);

      const history = await source.history(instrument, NOW - 3_600);
      expect(history[0]).to.include({ price: 337.19, t: Math.floor(Date.parse("2026-09-18T06:59:00Z") / 1000) });
      expect(seen.some((u) => u.includes("priceType=Index"))).to.equal(true);
    });

    it("gives every token on one underlying its own Backpack sample", async () => {
      // Regression: a map from symbol to one mint kept only the last token, so
      // the others' reference went stale and the gate refused them.
      const fetchStub = (async () => jsonResponse([{ symbol: "AAPL.US_USDC_PERP", indexPrice: "337.185" }])) as typeof fetch;
      const testMint = { ...instrument, mint: "DEVNET_AAPL_MINT" };
      const curve = { ...instrument, mint: "CURVE_AAPL_MINT" };
      const live = await new BackpackIndexSource("https://bp.test", fetchStub).sample([instrument, testMint, curve]);
      expect(live.map((s) => s.mint).sort()).to.deep.equal([instrument.mint, "CURVE_AAPL_MINT", "DEVNET_AAPL_MINT"].sort());
      expect(live.every((s) => s.point.price === 337.185)).to.equal(true);
    });

    it("prices many mints with one Jupiter request", async () => {
      let calls = 0;
      const fetchStub = (async () => {
        calls += 1;
        return jsonResponse({ AAPL_MINT: { usdPrice: 336.2 } });
      }) as typeof fetch;
      const other = { ...instrument, mint: "NVDA_MINT" };
      const samples = await new JupiterPriceSource("https://jup.test", fetchStub).sample([instrument, other]);
      expect(calls).to.equal(1);
      // A mint the API did not price is left out rather than recorded as zero.
      expect(samples.map((s) => s.mint)).to.deep.equal(["AAPL_MINT"]);
    });

    it("keeps when a mint's multiplier changes, after the moment as well as before", async () => {
      // As Jupiter serves AAPLx today: the change took effect on 8 August and is
      // still reported. A mint with no change scheduled names no moment.
      const fetchStub = (async () => jsonResponse({
        AAPL_MINT: {
          usdPrice: 339.47,
          scaledUiConfig: { multiplier: 1.0026642075893797, newMultiplier: 1.0032690125398187, newMultiplierEffectiveAt: "2026-08-08T00:30:00Z" },
        },
        NVDA_MINT: { usdPrice: 226.42, scaledUiConfig: { multiplier: 1 } },
      })) as typeof fetch;
      const source = new JupiterPriceSource("https://jup.test", fetchStub);
      await source.sample([instrument, { ...instrument, mint: "NVDA_MINT" }]);
      expect(source.multiplierChangeAt("AAPL_MINT")).to.equal(Math.floor(Date.parse("2026-08-08T00:30:00Z") / 1000));
      expect(source.multiplierChangeAt("NVDA_MINT")).to.equal(undefined);
    });

    it("backfills from the deepest USDC pool, waiting out a rate limit", async () => {
      let ohlcvCalls = 0;
      const fetchStub = (async (url: string) => {
        if (String(url).includes("/pools?")) {
          return jsonResponse({ data: [
            { attributes: { address: "SHALLOW", name: "AAPLx / USDC", reserve_in_usd: "10" } },
            { attributes: { address: "OTHER_QUOTE", name: "TREE / AAPLx", reserve_in_usd: "999999" } },
            { attributes: { address: "DEEP", name: "AAPLx / USDC", reserve_in_usd: "250000" } },
          ] });
        }
        expect(String(url)).to.contain("/pools/DEEP/");
        ohlcvCalls += 1;
        if (ohlcvCalls === 1) return jsonResponse({ status: "rate limited" }, 429);
        return jsonResponse({ data: { attributes: { ohlcv_list: [[NOW - 60, 1, 2, 0.5, 336.9, 100]] } } });
      }) as typeof fetch;

      const history = await new GeckoTerminalHistorySource("https://gt.test", fetchStub, 0, 0).history(instrument, NOW - 3_600);
      expect(ohlcvCalls).to.equal(2);
      expect(history).to.deep.equal([{ t: NOW - 60, price: 336.9, source: "geckoterminal" }]);
    });

    it("keeps recording from the sources that work when one fails", async () => {
      const tape = tapeAt(Math.floor(Date.now() / 1000));
      const failures: string[] = [];
      const working = { id: "ok", side: "tokenized" as const, sample: async () => [{ mint: AAPL.mint, side: "tokenized" as const, point: { t: Math.floor(Date.now() / 1000), price: 1, source: "ok" } }] };
      const broken = { id: "down", side: "reference" as const, sample: async () => { throw new Error("503"); } };
      await new PriceSampler(tape, () => [instrument], [working, broken], { onError: (id) => failures.push(id) }).tick();
      expect(tape.series(AAPL.mint, "tokenized")).to.have.length(1);
      expect(failures).to.deep.equal(["down"]);
    });
  });
});
