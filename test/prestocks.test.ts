import { expect } from "chai";
import {
  PreStocksRegistry,
  quoteProbeRoutability,
  SolanaRpcMintVerifier,
  TOKEN_2022_PROGRAM,
} from "../stocks";

describe("PreStocks discovery registry", () => {
  const openAiMint = "11111111111111111111111111111111";
  const spaceXMint = "22222222222222222222222222222222";
  const now = Date.parse("2026-09-16T12:00:00.000Z");
  let apiCalls = 0;
  let rpcCalls = 0;

  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("prestocks.test")) {
      apiCalls += 1;
      return jsonResponse([
        asset("OpenAI", "OPENAI", openAiMint, 10, 11, 100_000_000_000, 110_000_000_000, 1_000),
        asset("SpaceX", "SPACEX", spaceXMint, 20, 19, 200_000_000_000, 190_000_000_000, 2_000),
      ]);
    }
    rpcCalls += 1;
    const body = JSON.parse(String(init?.body)) as { params: [string[]] };
    expect(body.params[0]).to.deep.equal([openAiMint, spaceXMint]);
    return jsonResponse({
      jsonrpc: "2.0",
      id: "quaestor-prestocks",
      result: {
        value: [mintAccount("123450000000"), mintAccount("987650000000")],
      },
    });
  }) as typeof fetch;

  beforeEach(() => {
    apiCalls = 0;
    rpcCalls = 0;
  });

  it("normalizes provider data beside independently verified Token-2022 provenance", async () => {
    const verifier = new SolanaRpcMintVerifier("https://solana.test", request);
    const registry = new PreStocksRegistry(verifier, {
      endpoint: "https://prestocks.test/api/prestocks",
      fetch: request,
      now: () => now,
    });
    const instruments = await registry.instruments();
    const openAi = instruments[0];

    expect(instruments.map(({ symbol }) => symbol)).to.deep.equal(["OPENAI", "SPACEX"]);
    expect(openAi).to.include({
      provider: "prestocks",
      assetClass: "private-company-exposure",
      executionStatus: "discovery-only",
      enabled: false,
      tokenProgram: TOKEN_2022_PROGRAM,
      decimals: 9,
    });
    expect(openAi.rightsNotice).to.include("no ownership");
    expect(openAi.lifecycleNotice).to.include("corporate actions");
    expect(openAi.referenceData).to.deep.include({
      observedAt: "2026-09-16T12:00:00.000Z",
      markPriceUsd: "10",
      tokenPriceUsd: "11",
      premiumBps: 1000,
      providerReportedSupply: "1000",
      onchainMintSupply: "123.45",
    });
  });

  it("caches the verified snapshot without sharing mutable nested state", async () => {
    const registry = new PreStocksRegistry(new SolanaRpcMintVerifier("https://solana.test", request), {
      endpoint: "https://prestocks.test/api/prestocks",
      fetch: request,
      now: () => now,
    });
    const first = await registry.instruments();
    first[0].referenceData!.tokenPriceUsd = "tampered";
    const second = await registry.instruments();
    expect(second[0].referenceData!.tokenPriceUsd).to.equal("11");
    expect(apiCalls).to.equal(1);
    expect(rpcCalls).to.equal(1);
  });

  it("fails closed when a mint is absent or not owned by Token-2022", async () => {
    const missingFetch = (async () => jsonResponse({ result: { value: [null] } })) as typeof fetch;
    try {
      await new SolanaRpcMintVerifier("https://solana.test", missingFetch).verify([openAiMint]);
      expect.fail("expected missing mint failure");
    } catch (error) {
      expect((error as Error).message).to.include("does not exist");
    }

    const wrongProgramFetch = (async () => jsonResponse({
      result: { value: [{ ...mintAccount("1"), owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }] },
    })) as typeof fetch;
    try {
      await new SolanaRpcMintVerifier("https://solana.test", wrongProgramFetch).verify([openAiMint]);
      expect.fail("expected token program failure");
    } catch (error) {
      expect((error as Error).message).to.include("not owned by Token-2022");
    }
  });

  describe("routability", () => {
    /** A venue that only knows how to fill the mints it is given. */
    const venueFilling = (...mints: string[]) => ({
      quote: async (_input: string, output: string, amount: bigint) => {
        if (!mints.includes(output)) throw new Error("no route");
        return { minimumOutput: (amount * 99n) / 100n };
      },
    });

    const build = (routability?: ReturnType<typeof quoteProbeRoutability>) =>
      new PreStocksRegistry(new SolanaRpcMintVerifier("https://solana.test", request), {
        endpoint: "https://prestocks.test/api/prestocks",
        fetch: request,
        now: () => now,
        routability,
      });

    it("leaves every instrument discovery-only when nothing probes for a route", async () => {
      // The absence of a probe is not evidence that a route exists.
      const instruments = await build().instruments();
      expect(instruments).to.have.length(2);
      for (const instrument of instruments) {
        expect(instrument.enabled).to.equal(false);
        expect(instrument.executionStatus).to.equal("discovery-only");
        expect(instrument.tradableVenues).to.deep.equal([]);
      }
    });

    it("enables only the instruments a venue can actually fill", async () => {
      const instruments = await build(quoteProbeRoutability({
        jupiter: venueFilling(openAiMint),
      })).instruments();

      const openAi = instruments.find((i) => i.mint === openAiMint);
      const spaceX = instruments.find((i) => i.mint === spaceXMint);
      expect(openAi?.enabled).to.equal(true);
      expect(openAi?.executionStatus).to.equal("enabled");
      expect(openAi?.tradableVenues).to.deep.equal(["jupiter"]);
      // Listed, priced, described — and still not tradeable, because nothing
      // will fill it. That is the honest state for most of this catalogue.
      expect(spaceX?.enabled).to.equal(false);
      expect(spaceX?.tradableVenues).to.deep.equal([]);
    });

    it("records every venue that can fill a mint, in a stable order", async () => {
      const instruments = await build(quoteProbeRoutability({
        "meteora-dlmm": venueFilling(openAiMint, spaceXMint),
        jupiter: venueFilling(openAiMint),
      })).instruments();

      const openAi = instruments.find((i) => i.mint === openAiMint);
      // Sorted, not in whichever order the probes resolved, so a catalogue does
      // not reshuffle between refreshes.
      expect(openAi?.tradableVenues).to.deep.equal(["jupiter", "meteora-dlmm"]);
      expect(instruments.find((i) => i.mint === spaceXMint)?.tradableVenues)
        .to.deep.equal(["meteora-dlmm"]);
    });

    it("treats a venue that quotes without a guaranteed floor as no route", async () => {
      const instruments = await build(quoteProbeRoutability({
        jupiter: { quote: async () => ({ minimumOutput: undefined }) },
      })).instruments();

      // An answer with no floor is an opinion, not a fill.
      for (const instrument of instruments) expect(instrument.enabled).to.equal(false);
    });
  });

});

function asset(
  name: string,
  symbol: string,
  contractAddress: string,
  markPrice: number,
  tokenPrice: number,
  markValuation: number,
  impliedValuation: number,
  supply: number,
) {
  return {
    name,
    symbol,
    description: `${name} economic exposure`,
    image: `https://prestocks.test/${symbol}.png`,
    external_url: `https://prestocks.test/${symbol}`,
    contract_address: contractAddress,
    markPrice,
    markValuation,
    tokenPrice,
    impliedValuation,
    supply,
  };
}

function mintAccount(supply: string) {
  return {
    owner: TOKEN_2022_PROGRAM,
    data: {
      program: "spl-token-2022",
      parsed: { type: "mint", info: { decimals: 9, supply } },
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
