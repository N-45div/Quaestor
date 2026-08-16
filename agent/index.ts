import { ethers } from "ethers";
import * as dotenv from "dotenv";
import { Category, DecisionMeta, QuaestorAgent, DEX_ABI, decodeQuaestorError } from "../sdk";

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

interface AgentRuntime {
  sdk: QuaestorAgent;
  dex: ethers.Contract;
  agentId: bigint;
  agentName: string;
  tokenAddress: string;
  oracleUrl: string;
  intervalMs: number;
  baseBuyOkb: string;
  openrouterKey?: string;
  openrouterModel: string;
  inferenceSink?: string;
  inferenceFeeOkb: string;
}

const SLIPPAGE_BPS = 100n; // 1%

const now = () => new Date().toISOString();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export function agentRuntimeFromEnv(): AgentRuntime {
  const rpcUrl =
    process.env.RPC_URL ?? process.env.XLAYER_TESTNET_RPC ?? "http://127.0.0.1:8545";
  const agentId = BigInt(process.env.AGENT_ID ?? "1");
  const sdk = new QuaestorAgent({
    rpcUrl,
    quaestorAddress: required("QUAESTOR_ADDRESS"),
    dexAddress: required("DEX_ADDRESS"),
    privateKey: required("OPERATOR_KEY"),
    decisionLedgerUrl: process.env.DECISION_LEDGER_URL,
  });
  return {
    sdk,
    dex: new ethers.Contract(required("DEX_ADDRESS"), DEX_ABI, sdk.provider),
    agentId,
    agentName: process.env.AGENT_NAME ?? `agent-${agentId}`,
    tokenAddress: required("QUSD_ADDRESS"),
    oracleUrl: process.env.ORACLE_URL ?? "http://localhost:8402",
    intervalMs: Number(process.env.AGENT_INTERVAL_MS ?? 60_000),
    baseBuyOkb: process.env.AGENT_BASE_BUY_OKB ?? "0.02",
    openrouterKey: process.env.OPENROUTER_API_KEY,
    openrouterModel: process.env.OPENROUTER_MODEL ?? "google/gemini-3.6-flash",
    inferenceSink: process.env.INFERENCE_SINK,
    inferenceFeeOkb: process.env.INFERENCE_FEE_OKB ?? "0.0005",
  };
}

interface Signal {
  spotTokenPerOkb: string;
  smaTokenPerOkb: string;
  momentumBps: number;
}

async function buySignal(rt: AgentRuntime, log: (m: string) => void): Promise<Signal> {
  const quoteRes = await fetch(`${rt.oracleUrl}/quote`);
  if (!quoteRes.ok) throw new Error(`oracle quote failed: ${quoteRes.status}`);
  const quote = (await quoteRes.json()) as { priceWei: string; payee: string };

  const meta: DecisionMeta = {
    agent: rt.agentName,
    action: "buy-market-signal",
    rationale: "cycle start: purchase spot/SMA/momentum signal from oracle",
    inputs: { oracle: rt.oracleUrl, priceWei: quote.priceWei },
    timestamp: now(),
  };
  const { txHash } = await rt.sdk.pay(
    rt.agentId,
    Category.DATA,
    quote.payee,
    BigInt(quote.priceWei),
    meta
  );
  log(`DATA paid ${ethers.formatEther(quote.priceWei)} OKB → oracle (${txHash})`);

  const sigRes = await fetch(`${rt.oracleUrl}/signal`, {
    headers: { "x-quaestor-tx": txHash },
  });
  if (!sigRes.ok) throw new Error(`oracle signal failed: ${sigRes.status}`);
  const body = (await sigRes.json()) as { signal: Signal };
  return body.signal;
}

/** Ask an LLM to size the buy; meter its cost on-chain. Returns multiplier 0..2. */
async function llmSizing(
  rt: AgentRuntime,
  signal: Signal,
  log: (m: string) => void
): Promise<{ mult: number; reason: string }> {
  if (!rt.openrouterKey || !rt.inferenceSink) {
    const mult = signal.momentumBps < 0 ? 1.5 : 0.75;
    return { mult, reason: `deterministic DCA: momentum ${signal.momentumBps}bps` };
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${rt.openrouterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: rt.openrouterModel,
      messages: [
        {
          role: "system",
          content:
            'You size DCA buys. Reply with strict JSON {"mult": number between 0 and 2, "reason": string under 140 chars}. Higher momentum (price of OKB in tokens above SMA) should reduce the buy; dips should increase it. No other text.',
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
    agent: rt.agentName,
    action: "meter-inference",
    rationale: `LLM sizing call: ${parsed.reason}`,
    inputs: { signal: signal as unknown as Record<string, unknown> },
    model: rt.openrouterModel,
    timestamp: now(),
  };
  const { txHash } = await rt.sdk.pay(
    rt.agentId,
    Category.INFERENCE,
    rt.inferenceSink,
    ethers.parseEther(rt.inferenceFeeOkb),
    meta
  );
  log(`INFERENCE metered ${rt.inferenceFeeOkb} OKB → sink (${txHash})`);
  return { mult, reason: parsed.reason };
}

async function cycle(rt: AgentRuntime, log: (m: string) => void) {
  if (await rt.sdk.isSuspended(rt.agentId)) {
    log("agent is SUSPENDED by owner — standing down this cycle");
    return;
  }

  const signal = await buySignal(rt, log);
  log(
    `signal: spot ${ethers.formatEther(signal.spotTokenPerOkb)} sma ${ethers.formatEther(signal.smaTokenPerOkb)} momentum ${signal.momentumBps}bps`
  );

  const { mult, reason } = await llmSizing(rt, signal, log);
  const buyWei =
    (ethers.parseEther(rt.baseBuyOkb) * BigInt(Math.round(mult * 100))) / 100n;
  if (buyWei === 0n) {
    log(`sizing says skip (${reason})`);
    return;
  }

  const expectedOut: bigint = await rt.dex.getNativeToTokenOut(rt.tokenAddress, buyWei);
  const minOut = (expectedOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;

  const meta: DecisionMeta = {
    agent: rt.agentName,
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
  const { txHash } = await rt.sdk.swap(
    rt.agentId,
    buyWei,
    minOut,
    rt.tokenAddress,
    meta
  );
  log(
    `EXECUTION swapped ${ethers.formatEther(buyWei)} OKB → ≥${ethers.formatEther(minOut)} tokens (${txHash})`
  );
}

export async function runAgent(): Promise<never> {
  const rt = agentRuntimeFromEnv();
  const log = (msg: string) => console.log(`[${now()}] [${rt.agentName}] ${msg}`);
  log(`governed agent starting — agentId ${rt.agentId}, every ${rt.intervalMs / 1000}s`);
  for (;;) {
    try {
      await cycle(rt, log);
    } catch (err) {
      // The important product moment: the chain said no, and the agent survives it.
      const decoded = decodeQuaestorError(err);
      if (decoded) {
        log(`governor refused the spend — ${decoded} — standing down until the epoch resets`);
      } else {
        const msg = (err as Error).message ?? String(err);
        log(`cycle error: ${msg.slice(0, 300)}`);
      }
    }
    await new Promise((r) => setTimeout(r, rt.intervalMs));
  }
}

if (require.main === module) {
  runAgent().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
