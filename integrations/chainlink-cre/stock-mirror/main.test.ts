import { describe, expect } from "bun:test";
import { getNetwork } from "@chainlink/cre-sdk";
import { ConfidentialHttpMock, ConsensusMock, EvmMock, addContractMock, newTestRuntime, test } from "@chainlink/cre-sdk/test";
import { parseAbi } from "viem";
import { agentBody, due, initWorkflow, onCronTrigger, type Config } from "./main";

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

describe("onCronTrigger: write the moved prices, then start the agent", () => {
  const FEED = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);
  const config: Config = {
    schedule: "0 */15 * * * *",
    minMoveBps: 30,
    heartbeatSec: 21_600,
    source: { chainName: "ethereum-mainnet-arbitrum-1", feeds: { NVDA: "0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F" } },
    target: { chainName: "monad-testnet", receiver: "0xb3A434C305e9fB799118aF0aA4a1b532b56e79B1", gasLimit: "600000", mirrors: { NVDA: "0xC43D5C4B67127b5a8226baD23F09b5bA09a8afcf" } },
    agent: { url: "https://quaestor-stocks.onrender.com/v1/evm/monad-testnet/agent/run", owner: "0x74D4c4f4d79885D11BfAF9C58e69B7d1e3574eDe" },
  };
  const selector = (name: string) => getNetwork({ chainFamily: "evm", chainSelectorName: name })!.chainSelector.selector;

  function chains(source: bigint, mirror: bigint) {
    const from = EvmMock.testInstance(selector(config.source.chainName));
    const to = EvmMock.testInstance(selector(config.target.chainName));
    addContractMock(from, { address: config.source.feeds.NVDA as `0x${string}`, abi: FEED }).latestRoundData = () => [1n, source, 0n, 2_000n, 1n];
    const mirrorMock = addContractMock(to, { address: config.target.mirrors.NVDA as `0x${string}`, abi: FEED });
    mirrorMock.latestRoundData = () => [1n, mirror, 0n, 1_000n, 1n];
    const writes: unknown[] = [];
    addContractMock(to, { address: config.target.receiver as `0x${string}`, abi: FEED }).writeReport = (input) => {
      writes.push(input);
      return { txHash: Buffer.alloc(32, 7).toString("base64") };
    };
    ConsensusMock.testInstance().report = () => ({ rawReport: Buffer.from("report").toString("base64") });
    return writes;
  }

  test("after writing, starts the agent once, with the secret only as a vault template", () => {
    const writes = chains(PRICE * 2n, PRICE);
    const sent: { url?: string; body?: string; headers?: Record<string, string[]>; secrets?: { key: string; owner: string }[] }[] = [];
    ConfidentialHttpMock.testInstance().sendRequest = (input) => {
      const headers = Object.fromEntries(Object.entries(input.request!.multiHeaders).map(([k, v]) => [k, v.values]));
      sent.push({ url: input.request!.url, body: input.request!.body.value as string, headers, secrets: input.vaultDonSecrets.map((s) => ({ key: s.key, owner: s.owner })) });
      return { statusCode: 202, body: Buffer.from('{"started":true}').toString("base64") };
    };
    const runtime = newTestRuntime(null, {}, config);
    const tx = onCronTrigger(runtime);
    expect(writes).toHaveLength(1);
    expect(tx).toBe(`0x${"07".repeat(32)}`);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(config.agent!.url);
    expect(sent[0].headers!["x-agent-secret"]).toEqual(["{{.agentSecret}}"]);
    expect(sent[0].secrets).toEqual([{ key: "agentSecret", owner: config.agent!.owner }]);
    expect(JSON.parse(sent[0].body!)).toEqual(JSON.parse(agentBody(["NVDA"], tx)));
    expect(runtime.getLogs().join("\n")).toContain("started the agent: 202");
  });

  test("writes nothing and starts nothing when no price moved", () => {
    chains(PRICE, PRICE);
    let calls = 0;
    ConfidentialHttpMock.testInstance().sendRequest = () => { calls += 1; return { statusCode: 202 }; };
    expect(onCronTrigger(newTestRuntime(null, {}, config))).toBe("nothing moved; nothing written");
    expect(calls).toBe(0);
  });

  test("an agent that does not answer leaves the prices written", () => {
    chains(PRICE * 2n, PRICE);
    ConfidentialHttpMock.testInstance().sendRequest = () => { throw new Error("hub asleep"); };
    const runtime = newTestRuntime(null, {}, config);
    expect(onCronTrigger(runtime)).toBe(`0x${"07".repeat(32)}`);
    expect(runtime.getLogs().join("\n")).toContain("the agent did not start");
  });
});
