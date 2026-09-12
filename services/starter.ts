import type { Express } from "express";
import { ethers } from "ethers";
import { Category, QuaestorAgent, QUAESTOR_ABI, decodeQuaestorError, type DecisionMeta } from "../sdk";

/**
 * The no-wallet onboarding lane. Two real product surfaces:
 *
 *   GET  /api/heartbeat      — the governed heartbeat: a real on-chain spend
 *                              by the house agent (Pulse) that doubles as
 *                              continuous synthetic monitoring. If this
 *                              returns a receipt, every layer of the stack —
 *                              RPC, governor, oracle, ledger — just worked.
 *   POST /api/starter/claim  — a starter treasury: Quaestor sponsors your
 *                              first agent. Real registration, dust caps,
 *                              1-hour epochs, gas included. Outgrow it and
 *                              register your own treasury in the dashboard.
 *   GET  /api/starter/status — remaining sponsorship budget, in the open.
 *
 * X Layer's testnet faucet is gated behind an OKX Wallet with a balance, so
 * this lane exists to make the first governed spend cost a visitor nothing.
 * Abuse control is Quaestor itself: the caps are on-chain, and when a budget
 * is drained the chain refuses — which is the product doing its job.
 */

export interface StarterConfig {
  provider: ethers.JsonRpcProvider;
  rpcUrl: string;
  quaestorAddress: string;
  dexAddress: string;
  oracleBase: string;
  explorerTx: string;
  heartbeatAgentId: bigint;
  heartbeatOperatorKey: string;
  sponsorOwnerKey?: string;
}

export function starterConfigFromEnv(
  provider: ethers.JsonRpcProvider,
  rpcUrl: string
): StarterConfig | null {
  const operatorKey =
    process.env.HEARTBEAT_OPERATOR_KEY ?? process.env.PROBA_OPERATOR_KEY;
  if (!operatorKey) return null;
  return {
    provider,
    rpcUrl,
    quaestorAddress: process.env.QUAESTOR_ADDRESS!,
    dexAddress: process.env.DEX_ADDRESS!,
    oracleBase: process.env.SELF_URL ?? `http://localhost:${process.env.PORT ?? 8402}`,
    explorerTx: process.env.EXPLORER_TX ?? "https://www.oklink.com/xlayer-test/tx/",
    heartbeatAgentId: BigInt(
      process.env.HEARTBEAT_AGENT_ID ?? process.env.PROBA_AGENT_ID ?? "3"
    ),
    heartbeatOperatorKey: operatorKey,
    sponsorOwnerKey: process.env.STARTER_OWNER_KEY ?? process.env.DEMO_OWNER_KEY,
  };
}

/** Sponsored starter treasuries: dust caps, one-hour epochs. */
const STARTER_POLICY = {
  data: { epochCap: ethers.parseEther("0.0005"), perCallCap: ethers.parseEther("0.0001") },
  inference: { epochCap: 0n, perCallCap: 0n },
  execution: { epochCap: ethers.parseEther("0.0005"), perCallCap: ethers.parseEther("0.00025") },
};
const STARTER_DEPOSIT = ethers.parseEther("0.001");
const STARTER_GAS = ethers.parseEther("0.0008");
const STARTER_EPOCH_S = 3600;

const HEARTBEAT_COOLDOWN_MS = 60_000; // per IP
const CLAIM_COOLDOWN_MS = 10 * 60_000; // per IP
const MAX_HEARTBEATS_PER_DAY = 200;
// A public curl must never hang on a stalled RPC. Answer inside this window and
// let the spend land on its own; /receipts shows it when it does.
const HEARTBEAT_DEADLINE_MS = 45_000;
const MAX_CLAIMS_PER_DAY = 20;

export function mountStarter(app: Express, cfg: StarterConfig): void {
  const pulse = new QuaestorAgent({
    rpcUrl: cfg.rpcUrl,
    quaestorAddress: cfg.quaestorAddress,
    dexAddress: cfg.dexAddress,
    privateKey: cfg.heartbeatOperatorKey,
    decisionLedgerUrl: cfg.oracleBase,
  });
  const sponsor = cfg.sponsorOwnerKey
    ? new ethers.NonceManager(new ethers.Wallet(cfg.sponsorOwnerKey, cfg.provider))
    : null;
  const quaestorAsSponsor = sponsor
    ? new ethers.Contract(cfg.quaestorAddress, QUAESTOR_ABI, sponsor)
    : null;

  const lastBeatByIp = new Map<string, number>();
  const lastClaimByIp = new Map<string, number>();
  let dayBeats = 0;
  let dayClaims = 0;
  let dayStart = Date.now();

  const rollDay = () => {
    if (Date.now() - dayStart > 24 * 3600_000) {
      dayBeats = 0;
      dayClaims = 0;
      dayStart = Date.now();
    }
  };

  const ipOf = (req: any): string =>
    (req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.ip ?? "?").trim();

  const heartbeat = async (req: any, res: any) => {
    rollDay();
    const ip = ipOf(req);
    const last = lastBeatByIp.get(ip) ?? 0;
    if (Date.now() - last < HEARTBEAT_COOLDOWN_MS) {
      return res.status(429).json({
        error: "one heartbeat per minute per caller — the governor teaches patience",
      });
    }
    if (dayBeats >= MAX_HEARTBEATS_PER_DAY) {
      return res
        .status(429)
        .json({ error: "daily heartbeat budget exhausted, back tomorrow" });
    }
    lastBeatByIp.set(ip, Date.now());
    dayBeats++;
    const deadline = setTimeout(() => {
      if (res.headersSent) return;
      res.status(504).json({
        alive: null,
        error:
          "the X Layer RPC did not answer within 45s; the beat may still land — check /receipts in a minute",
      });
    }, HEARTBEAT_DEADLINE_MS);

    try {
      const quote = await fetch(`${cfg.oracleBase}/quote`).then((r) => r.json());
      const meta: DecisionMeta = {
        agent: "Pulse — governed heartbeat",
        action: "heartbeat",
        rationale:
          "scheduled liveness proof: pay the oracle for one signal through the governor; a returned receipt verifies RPC, governor, oracle, and ledger in one transaction",
        inputs: { caller: "public", priceWei: quote.priceWei },
        timestamp: new Date().toISOString(),
      };
      const { txHash, metaHash } = await pulse.pay(
        cfg.heartbeatAgentId,
        Category.DATA,
        quote.payee,
        BigInt(quote.priceWei),
        meta
      );
      const signal = await fetch(`${cfg.oracleBase}/signal`, {
        headers: { "x-quaestor-tx": txHash },
      }).then((r) => r.json());
      const remaining = await pulse.remainingBudget(cfg.heartbeatAgentId, Category.DATA);

      clearTimeout(deadline);
      if (res.headersSent) return;
      res.json({
        alive: true,
        what_this_is:
          "A real governed spend on X Layer testnet, just now: the heartbeat agent paid the oracle through the Quaestor governor within on-chain caps and committed a hash of its rationale. If you can read this, the whole stack works.",
        receipt: {
          tx: txHash,
          explorer: `${cfg.explorerTx}${txHash}`,
          decision_hash: metaHash,
          paid_okb: ethers.formatEther(BigInt(quote.priceWei)),
        },
        signal: signal.signal ?? signal,
        budget_after: {
          data_remaining_okb: ethers.formatEther(remaining),
          note: "when this hits zero, the chain refuses the next beat — no server involved",
        },
        decision_record: `${cfg.oracleBase}/decisions/${metaHash}`,
        dashboard: "https://quaestor-app.onrender.com/#/app",
      });
    } catch (err) {
      clearTimeout(deadline);
      if (res.headersSent) return;
      // The governor's refusals are named custom errors; say which one, not
      // "unknown custom error", because the name is the whole point.
      const decoded = decodeQuaestorError(err);
      const msg = decoded ?? ((err as Error).message ?? String(err));
      if (/EpochCapExceeded|PerCallCapExceeded/.test(msg)) {
        return res.status(402).json({
          alive: true,
          refusal: msg,
          the_point_exactly:
            "The heartbeat's DATA budget for this epoch is spent and the chain just refused the next beat. That refusal IS the liveness proof — the governor is enforcing. Budget resets within the hour.",
        });
      }
      if (/InsufficientTreasury/.test(msg)) {
        return res.status(503).json({
          alive: false,
          refusal: msg,
          why:
            "The house agent's treasury is empty, so the chain refused the beat — correctly. Only the owner can deposit; the operator key cannot. A funding gap, not an outage: the governor is doing its job.",
        });
      }
      if ((err as { code?: string })?.code === "TIMEOUT") {
        return res.status(504).json({
          alive: null,
          error: "the X Layer RPC timed out; the beat may still land — check /receipts in a minute",
        });
      }
      res.status(500).json({ alive: false, error: msg.slice(0, 200) });
    }
  };

  app.get("/api/heartbeat", heartbeat);
  app.get("/api/demo/spend", heartbeat); // legacy alias

  const claim = async (req: any, res: any) => {
    rollDay();
    if (!sponsor || !quaestorAsSponsor) {
      return res
        .status(503)
        .json({ error: "starter treasuries disabled (no sponsor key configured)" });
    }
    const ip = ipOf(req);
    const last = lastClaimByIp.get(ip) ?? 0;
    if (Date.now() - last < CLAIM_COOLDOWN_MS) {
      return res.status(429).json({ error: "one starter treasury per 10 minutes per caller" });
    }
    if (dayClaims >= MAX_CLAIMS_PER_DAY) {
      return res
        .status(429)
        .json({ error: "daily sponsorship budget exhausted, back tomorrow" });
    }
    lastClaimByIp.set(ip, Date.now());
    dayClaims++;

    try {
      const operatorWallet = ethers.Wallet.createRandom();
      const tx = await quaestorAsSponsor.registerAgent(
        operatorWallet.address,
        STARTER_EPOCH_S,
        JSON.stringify({ name: `Starter ${new Date().toISOString().slice(0, 10)}` }),
        STARTER_POLICY.data,
        STARTER_POLICY.inference,
        STARTER_POLICY.execution,
        { value: STARTER_DEPOSIT }
      );
      const rcpt = await tx.wait();
      const registered = rcpt.logs
        .map((l: any) => {
          try {
            return quaestorAsSponsor.interface.parseLog({
              topics: [...l.topics],
              data: l.data,
            });
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "AgentRegistered");
      const agentId = registered?.args.agentId?.toString();

      const gasTx = await sponsor.sendTransaction({
        to: operatorWallet.address,
        value: STARTER_GAS,
      });
      await gasTx.wait();

      res.json({
        agent_id: agentId,
        operator_address: operatorWallet.address,
        operator_key: operatorWallet.privateKey,
        what_you_got:
          "A real on-chain agent with a sponsored treasury. The key can spend only through the governor, only within its caps. When you outgrow it, register your own treasury in the dashboard — same contract, your funds, your caps.",
        env: [
          `RPC_URL=${cfg.rpcUrl}`,
          `QUAESTOR_ADDRESS=${cfg.quaestorAddress}`,
          `DEX_ADDRESS=${cfg.dexAddress}`,
          `QUSD_ADDRESS=${process.env.QUSD_ADDRESS ?? ""}`,
          `AGENT_ID=${agentId}`,
          `OPERATOR_KEY=${operatorWallet.privateKey}`,
          `ORACLE_URL=${cfg.oracleBase}`,
          `DECISION_LEDGER_URL=${cfg.oracleBase}`,
          `AGENT_INTERVAL_MS=120000`,
          `AGENT_BASE_BUY_OKB=0.0002`,
        ].join("\n"),
        run: "git clone https://github.com/N-45div/Quaestor && cd Quaestor && npm install && npm run agent",
        mcp: "or plug the same env into mcp/server.ts and drive it from Claude/Cursor",
        watch: "https://quaestor-app.onrender.com/#/app",
        register_tx: `${cfg.explorerTx}${rcpt.hash}`,
      });
    } catch (err) {
      res.status(500).json({ error: ((err as Error).message ?? "").slice(0, 200) });
    }
  };

  app.post("/api/starter/claim", claim);
  app.post("/api/demo/agent", claim); // legacy alias

  const status = async (_req: any, res: any) => {
    rollDay();
    try {
      const remaining = await pulse.remainingBudget(cfg.heartbeatAgentId, Category.DATA);
      res.json({
        heartbeat_agent_id: cfg.heartbeatAgentId.toString(),
        heartbeat_data_remaining_okb: ethers.formatEther(remaining),
        heartbeats_today: dayBeats,
        starters_claimed_today: dayClaims,
        starter_treasuries_enabled: Boolean(sponsor),
      });
    } catch (err) {
      res.status(500).json({ error: ((err as Error).message ?? "").slice(0, 160) });
    }
  };

  app.get("/api/starter/status", status);
  app.get("/api/demo/status", status); // legacy alias

  console.log(
    `[starter] mounted — Pulse #${cfg.heartbeatAgentId}, starter treasuries ${sponsor ? "ENABLED" : "disabled"}`
  );
}
