import { describe, expect } from "bun:test";
import { test } from "@chainlink/cre-sdk/test";
import { due, initWorkflow, type Config } from "./main";

// $234.70 with Chainlink's 8 decimals, last updated at a Friday close.
const at = (answer: bigint, updatedAt: number) => ({ answer, updatedAt: BigInt(updatedAt) });
const PRICE = 23_470_000_000n;

describe("due: which of Chainlink's rounds are copied onto Monad", () => {
  test("writes into an empty mirror", () => {
    expect(due(at(PRICE, 100), at(0n, 0), 30, 21_600)).toBe(true);
  });

  test("writes a move of at least the threshold, either way", () => {
    expect(due(at((PRICE * 10_030n) / 10_000n, 200), at(PRICE, 100), 30, 21_600)).toBe(true);
    expect(due(at((PRICE * 9_970n) / 10_000n, 200), at(PRICE, 100), 30, 21_600)).toBe(true);
  });

  test("skips a smaller move until the source has gone a heartbeat past the mirror", () => {
    const nudged = (PRICE * 10_010n) / 10_000n;
    expect(due(at(nudged, 200), at(PRICE, 100), 30, 21_600)).toBe(false);
    expect(due(at(nudged, 100 + 21_600), at(PRICE, 100), 30, 21_600)).toBe(true);
  });

  test("never writes a round the mirror already holds, an older one, or a non-positive price", () => {
    expect(due(at(PRICE * 2n, 100), at(PRICE, 100), 30, 21_600)).toBe(false);
    expect(due(at(PRICE * 2n, 90), at(PRICE, 100), 30, 21_600)).toBe(false);
    expect(due(at(0n, 200), at(PRICE, 100), 30, 21_600)).toBe(false);
    expect(due(at(-1n, 200), at(0n, 0), 30, 21_600)).toBe(false);
  });
});

describe("initWorkflow", () => {
  test("one cron handler on the configured schedule", () => {
    const config = { schedule: "0 */15 * * * *" } as Config;
    const handlers = initWorkflow(config);
    expect(handlers).toHaveLength(1);
    expect(handlers[0].trigger.config.schedule).toBe("0 */15 * * * *");
  });
});
