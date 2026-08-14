import { ethers } from "ethers";
import * as dotenv from "dotenv";
import { Category, DecisionMeta, QuaestorAgent, DEX_ABI } from "../sdk";

dotenv.config();

/**
 * An example governed agent: DCA into a token on QuaestorDEX, with every cost
 * flowing through the Quaestor governor.
 *
 * Each cycle:
 *   1. DATA       — pays the oracle on-chain, redeems the receipt for a signal
 *   2. INFERENCE  — optionally asks an LLM to size the buy; the inference cost
 *                   is metered on-chain to INFERENCE_SINK so off-chain spend
 *                   still leaves an on-chain receipt
 *   3. EXECUTION  — swaps OKB for the token via the governor, within caps
 *
 * If the governor refuses (cap hit, suspended), the agent logs it and waits —
 * it cannot overspend, because enforcement lives on the chain, not here.
 */

const RPC_URL =
  process.env.RPC_URL ?? process.env.XLAYER_TESTNET_RPC ?? "http://127.0.0.1:8545";
const QUAESTOR_ADDRESS = required("QUAESTOR_ADDRESS");
const DEX_ADDRESS = required("DEX_ADDRESS");
const TOKEN_ADDRESS = required("QUSD_ADDRESS");
const OPERATOR_KEY = required("OPERATOR_KEY");
const AGENT_ID = BigInt(process.env.AGENT_ID ?? "1");
const ORACLE_URL = process.env.ORACLE_URL ?? "http://localhost:8402";
const INTERVAL_MS = Number(process.env.AGENT_INTERVAL_MS ?? 60_000);
const BASE_BUY_OKB = process.env.AGENT_BASE_BUY_OKB ?? "0.02";
const SLIPPAGE_BPS = 100n; // 1%

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "google/gemini-3.6-flash";
const INFERENCE_SINK = process.env.INFERENCE_SINK;
const INFERENCE_FEE_OKB = process.env.INFERENCE_FEE_OKB ?? "0.0005";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const sdk = new QuaestorAgent({
  rpcUrl: RPC_URL,
  quaestorAddress: QUAESTOR_ADDRESS,
  dexAddress: DEX_ADDRESS,
  privateKey: OPERATOR_KEY,
});
const dex = new ethers.Contract(DEX_ADDRESS, DEX_ABI, sdk.provider);

const AGENT_NAME = process.env.AGENT_NAME ?? `agent-${AGENT_ID}`;
const now = () => new Date().toISOString();
const log = (msg: string) => console.log(`[${now()}] ${msg}`);

interface Signal {
  spotTokenPerOkb: string;
  smaTokenPerOkb: string;
  momentumBps: number;
}

async function buySignal(): Promise<Signal | null> {
  const quoteRes = await fetch(`${ORACLE_URL}/quote`);
  if (!quoteRes.ok) throw new Error(`oracle quote failed: ${quoteRes.status}`);
  const quote = (await quoteRes.json()) as { priceWei: string; payee: string };

  const meta: DecisionMeta = {
    agent: AGENT_NAME,
    action: "buy-market-signal",
    rationale: "cycle start: purchase spot/SMA/momentum signal from oracle",
    inputs: { oracle: ORACLE_URL, priceWei: quote.priceWei },
    timestamp: now(),
  };
  const { txHash } = await sdk.pay(
    AGENT_ID,
    Category.DATA,
    quote.payee,
    BigInt(quote.priceWei),
    meta
  );
  log(`DATA paid ${ethers.formatEther(quote.priceWei)} OKB → oracle (${txHash})`);

  const sigRes = await fetch(`${ORACLE_URL}/signal`, {
    headers: { "x-quaestor-tx": txHash },
  });
  if (!sigRes.ok) throw new Error(`oracle signal failed: ${sigRes.status}`);
  const body = (await sigRes.json()) as { signal: Signal };
  return body.signal;
}

/** Ask an LLM to size the buy; meter its cost on-chain. Returns multiplier 0..2. */
async function llmSizing(signal: Signal): Promise<{ mult: number; reason: string }> {
  if (!OPENROUTER_API_KEY || !INFERENCE_SINK) {
    // Deterministic fallback: lean into dips, ease off rallies
    const mult = signal.momentumBps < 0 ? 1.5 : 0.75;
    return { mult, reason: `deterministic DCA: momentum ${signal.momentumBps}bps` };
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You size DCA buys. Reply with strict JSON {\"mult\": number between 0 and 2, \"reason\": string under 140 chars}. Higher momentum (price of OKB in tokens above SMA) should reduce the buy; dips should increase it. No other text.",
        },
        { role: "user", content: JSON.stringify(signal) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openrouter failed: ${res.status}`);
  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  const parsed = JSON.parse(data.choices[0].message.content) as {
    mult: number;
    reason: string;
  };
  const mult = Math.min(2, Math.max(0, parsed.mult));

  const meta: DecisionMeta = {
    agent: AGENT_NAME,
    action: "meter-inference",
    rationale: `LLM sizing call: ${parsed.reason}`,
    inputs: { signal: signal as unknown as Record<string, unknown> },
    model: OPENROUTER_MODEL,
    timestamp: now(),
  };
  const { txHash } = await sdk.pay(
    AGENT_ID,
    Category.INFERENCE,
    INFERENCE_SINK,
    ethers.parseEther(INFERENCE_FEE_OKB),
    meta
  );
  log(`INFERENCE metered ${INFERENCE_FEE_OKB} OKB → sink (${txHash})`);
  return { mult, reason: parsed.reason };
}

async function cycle() {
  if (await sdk.isSuspended(AGENT_ID)) {
    log("agent is SUSPENDED by owner — standing down this cycle");
    return;
  }

  const signal = await buySignal();
  if (!signal) return;
  log(
    `signal: spot ${ethers.formatEther(signal.spotTokenPerOkb)} sma ${ethers.formatEther(signal.smaTokenPerOkb)} momentum ${signal.momentumBps}bps`
  );

  const { mult, reason } = await llmSizing(signal);
  const buyWei =
    (ethers.parseEther(BASE_BUY_OKB) * BigInt(Math.round(mult * 100))) / 100n;
  if (buyWei === 0n) {
    log(`sizing says skip (${reason})`);
    return;
  }

  const expectedOut: bigint = await dex.getNativeToTokenOut(TOKEN_ADDRESS, buyWei);
  const minOut = (expectedOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;

  const meta: DecisionMeta = {
    agent: AGENT_NAME,
    action: "dca-buy",
    rationale: reason,
    inputs: {
      buyWei: buyWei.toString(),
      expectedOut: expectedOut.toString(),
      minOut: minOut.toString(),
      signal: signal as unknown as Record<string, unknown>,
    },
    timestamp: now(),
  };
  const { txHash } = await sdk.swap(AGENT_ID, buyWei, minOut, TOKEN_ADDRESS, meta);
  log(
    `EXECUTION swapped ${ethers.formatEther(buyWei)} OKB → ≥${ethers.formatEther(minOut)} tokens (${txHash})`
  );
}

async function main() {
  log(`governed agent "${AGENT_NAME}" starting — agentId ${AGENT_ID}, every ${INTERVAL_MS / 1000}s`);
  for (;;) {
    try {
      await cycle();
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // The important product moment: the chain said no, and the agent survives it.
      if (/EpochCapExceeded|PerCallCapExceeded|AgentIsSuspended|InsufficientTreasury/.test(msg)) {
        log(`governor refused the spend — ${msg.slice(0, 200)}`);
      } else {
        log(`cycle error: ${msg.slice(0, 300)}`);
      }
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
