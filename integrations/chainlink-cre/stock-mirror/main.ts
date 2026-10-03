/**
 * Chainlink's stock prices, onto Monad, by Chainlink CRE.
 *
 * Chainlink publishes no stock feeds on Monad. On a schedule, this workflow reads Chainlink's own
 * NVDA, SPY and AAPL feeds on Arbitrum One, compares each with the mirror a Quaestor governor's
 * price guard reads on Monad testnet, and writes the ones that moved (or whose source has gone a
 * heartbeat further) in one signed report to QuaestorMirrorReceiver, the only relayer those
 * mirrors accept. Monad charges a transaction its whole gas limit, so nothing moved means
 * nothing is written.
 */
import {
  CronCapability,
  EVMClient,
  LAST_FINALIZED_BLOCK_NUMBER,
  LATEST_BLOCK_NUMBER,
  Runner,
  bytesToHex,
  encodeCallMsg,
  getNetwork,
  handler,
  hexToBase64,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, stringToHex, zeroAddress, type Hex } from "viem";

export type Config = {
  schedule: string;
  /** Write a stock whose source moved at least this far from the mirror, in basis points. */
  minMoveBps: number;
  /** Write it anyway once its source has updated this many seconds past the mirror's round. */
  heartbeatSec: number;
  source: { chainName: string; feeds: Record<string, string> };
  target: { chainName: string; receiver: string; mirrors: Record<string, string>; gasLimit: string };
};

export type Round = { answer: bigint; updatedAt: bigint };

const FEED_ABI = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

/**
 * Whether a stock's source round should be copied over the mirror's. (A const, not a function
 * declaration: the WebAssembly compiler refuses exported function declarations with parameters.)
 */
export const due = (source: Round, mirror: Round, minMoveBps: number, heartbeatSec: number): boolean => {
  if (source.answer <= 0n || source.updatedAt <= mirror.updatedAt) return false;
  if (mirror.answer <= 0n) return true;
  const diff = source.answer > mirror.answer ? source.answer - mirror.answer : mirror.answer - source.answer;
  return (diff * 10_000n) / mirror.answer >= BigInt(minMoveBps) || source.updatedAt - mirror.updatedAt >= BigInt(heartbeatSec);
};

function clientFor(chainName: string): EVMClient {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: chainName });
  if (!network) throw new Error(`unknown chain ${chainName}`);
  return new EVMClient(network.chainSelector.selector);
}

function readRound(runtime: Runtime<Config>, client: EVMClient, feed: string, blockNumber: typeof LATEST_BLOCK_NUMBER): Round {
  const reply = client
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to: feed as Hex, data: encodeFunctionData({ abi: FEED_ABI, functionName: "latestRoundData" }) }),
      blockNumber,
    })
    .result();
  const [, answer, , updatedAt] = decodeFunctionResult({ abi: FEED_ABI, functionName: "latestRoundData", data: bytesToHex(reply.data) });
  return { answer, updatedAt };
}

export const onCronTrigger = (runtime: Runtime<Config>): string => {
  const { source, target, minMoveBps, heartbeatSec } = runtime.config;
  const from = clientFor(source.chainName);
  const to = clientFor(target.chainName);

  const symbols: Hex[] = [];
  const answers: bigint[] = [];
  const times: bigint[] = [];
  for (const [symbol, feed] of Object.entries(source.feeds)) {
    const mirror = target.mirrors[symbol];
    if (!mirror) throw new Error(`no mirror for ${symbol} on ${target.chainName}`);
    const src = readRound(runtime, from, feed, LAST_FINALIZED_BLOCK_NUMBER);
    const held = readRound(runtime, to, mirror, LATEST_BLOCK_NUMBER);
    const write = due(src, held, minMoveBps, heartbeatSec);
    runtime.log(`${symbol}: Chainlink ${src.answer} at ${src.updatedAt}, mirror ${held.answer} at ${held.updatedAt}${write ? " -> write" : ""}`);
    if (!write) continue;
    symbols.push(stringToHex(symbol, { size: 32 }));
    answers.push(src.answer);
    times.push(src.updatedAt);
  }
  if (!symbols.length) return "nothing moved; nothing written";

  const payload = encodeAbiParameters(parseAbiParameters("bytes32[] symbols, int256[] answers, uint256[] updatedAts"), [symbols, answers, times]);
  const report = runtime
    .report({ encodedPayload: hexToBase64(payload), encoderName: "evm", signingAlgo: "ecdsa", hashingAlgo: "keccak256" })
    .result();
  const written = to.writeReport(runtime, { receiver: target.receiver, report, gasConfig: { gasLimit: target.gasLimit } }).result();
  const tx = bytesToHex(written.txHash ?? new Uint8Array(32));
  runtime.log(`wrote ${symbols.length} price(s) to ${target.receiver}: ${tx}`);
  return tx;
};

export const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
