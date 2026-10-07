import { describe, it } from "vitest";
import { createTestIndexer } from "envio";

/**
 * The indexer against real Monad testnet blocks, through HyperSync: the house agent's governor as
 * the factory made it (its rules, its five stocks), the prices Chainlink CRE wrote, and the trade
 * Kimi then made on one of them, with the running totals that trade moved.
 */
const MONAD = 10143;
const GOVERNOR = "0xd64e22ff0d0dc311d89bcc5c5113f9e7f149157c";
const AGENT = "0xc813451f9fe540b754abe526bac4ee19e4043ff8"; // the agent's Dynamic MPC wallet
const NVDA = "0xf798f55d7c76385877e5a3a53302697e3474e750";

describe("Quaestor on Monad", () => {
  it("indexes a governor with its rules, CRE's prices, and the agent's trade on them", async (t) => {
    const indexer = createTestIndexer();

    // The house agent's governor: created by the factory, then set up in the same transaction.
    await indexer.process({ chains: { [MONAD]: { startBlock: 68_638_961, endBlock: 68_638_961 } } });
    const governor = await indexer.Governor.getOrThrow(GOVERNOR);
    t.expect(governor).toMatchObject({ agent_id: AGENT, owner: "0xd486faaa06a5630ab1c61519011584df5f07e7dd", perTradeCap: 3_000_000n, epochCap: 10_000_000n, epochLength: 86_400n, suspended: false, deposit: 30_000_000n });
    const instruments = (await indexer.Instrument.getAll()).filter((i) => i.governor_id === GOVERNOR);
    t.expect(instruments.map((i) => i.symbol).sort()).toEqual(["tAAPL", "tETH", "tNVDA", "tSPY", "tTSLA"]);
    t.expect(instruments.every((i) => i.allowed && i.maxDeviationBps === 100 && i.maxStaleness === 72 * 3600)).toBe(true);
    t.expect((await indexer.Agent.getOrThrow(AGENT)).governorCount).toBe(1);

    // Chainlink CRE writes NVDA, SPY and AAPL; Kimi buys tNVDA on the fresh price.
    await indexer.process({ chains: { [MONAD]: { startBlock: 68_892_401, endBlock: 68_892_526 } } });
    const nvda = await indexer.Feed.getOrThrow("NVDA");
    t.expect(nvda.answer).toBe(24_005_500_000n);
    t.expect((await indexer.Feed.getAll()).map((f) => f.id).sort()).toEqual(["AAPL", "NVDA", "SPY"]);

    const trade = (await indexer.Trade.getAll()).find((x) => x.txHash === "0x1e1d6f1029f4dda07855b20d2efd94c43c32869e96207dd5cc2fb2fd8f7a07aa");
    t.expect(trade).toMatchObject({ governor_id: GOVERNOR, agent_id: AGENT, symbol: "tNVDA", spent: 2_000_000n, received: 8_333_680_000_000_000n });
    t.expect(Number(trade!.pricePerToken.toFixed(2))).toBeCloseTo(239.99, 2);
    const holding = await indexer.Instrument.getOrThrow(`${GOVERNOR}-${NVDA}`);
    t.expect(holding).toMatchObject({ bought: 8_333_680_000_000_000n, spent: 2_000_000n, tradeCount: 1 });
  });
});
