import type { Express } from "express";
import { ethers } from "ethers";
import { Category, QuaestorAgent, QUAESTOR_ABI, type DecisionMeta } from "../sdk";

/**
 * The "try it without a wallet" lane.
 *
 * X Layer's testnet faucet is gated (OKX Wallet + balance requirements), so a
 * visitor may not be able to fund anything. This module removes the need:
 *
 *   GET  /api/demo/spend  — one-shot: the resident demo agent (Proba) makes a
 *                           real governed DATA payment to the oracle and
 *                           returns the receipt + proof links. curl-able.
 *   POST /api/demo/agent  — mints a fresh operator key, registers a new
 *                           dust-capped agent funded by the demo owner, and
 *                           returns a ready-to-run .env. The governor's own
 *                           caps are the abuse protection.
 *   GET  /api/demo/status — remaining demo budget, so abuse is also visible.
 *
 * Everything here spends real (testnet) OKB, so it is rate-limited per IP and
 * capped globally per day — and every spend still flows through Quaestor.
 */

export interface DemoConfig {
  provider: ethers.JsonRpcProvider;
  rpcUrl: string;
  quaestorAddress: string;
  dexAddress: string;
  oracleBase: string; // self base URL for paying the oracle
  explorerTx: string;
  /** Proba: the resident demo agent */
  probaAgentId: bigint;
  probaOperatorKey: string;
  /** Owner key that registers + funds visitor demo agents */
  demoOwnerKey?: string;
}

export function demoConfigFromEnv(
  provider: ethers.JsonRpcProvider,
  rpcUrl: string
): DemoConfig | null {
  if (!process.env.PROBA_OPERATOR_KEY) return null;
  return {
    provider,
    rpcUrl,
    quaestorAddress: process.env.QUAESTOR_ADDRESS!,
    dexAddress: process.env.DEX_ADDRESS!,
    oracleBase: process.env.SELF_URL ?? `http://localhost:${process.env.PORT ?? 8402}`,
    explorerTx: process.env.EXPLORER_TX ?? "https://www.oklink.com/xlayer-test/tx/",
    probaAgentId: BigInt(process.env.PROBA_AGENT_ID ?? "2"),
    probaOperatorKey: process.env.PROBA_OPERATOR_KEY,
    demoOwnerKey: process.env.DEMO_OWNER_KEY,
  };
}

/** Tiny fixed caps for visitor-created demo agents. */
const VISITOR_POLICY = {
  data: { epochCap: ethers.parseEther("0.0005"), perCallCap: ethers.parseEther("0.0001") },
  inference: { epochCap: 0n, perCallCap: 0n },
  execution: { epochCap: ethers.parseEther("0.0005"), perCallCap: ethers.parseEther("0.00025") },
};
const VISITOR_DEPOSIT = ethers.parseEther("0.001");
const VISITOR_GAS = ethers.parseEther("0.0008");
const VISITOR_EPOCH_S = 3600;

const SPEND_COOLDOWN_MS = 60_000; // per IP
const AGENT_COOLDOWN_MS = 10 * 60_000; // per IP
const MAX_SPENDS_PER_DAY = 200;
const MAX_AGENTS_PER_DAY = 20;

export function mountDemo(app: Express, cfg: DemoConfig): void {
  const proba = new QuaestorAgent({
    rpcUrl: cfg.rpcUrl,
    quaestorAddress: cfg.quaestorAddress,
    dexAddress: cfg.dexAddress,
    privateKey: cfg.probaOperatorKey,
    decisionLedgerUrl: cfg.oracleBase,
  });
  const owner = cfg.demoOwnerKey
    ? new ethers.NonceManager(new ethers.Wallet(cfg.demoOwnerKey, cfg.provider))
    : null;
  const quaestorAsOwner = owner
    ? new ethers.Contract(cfg.quaestorAddress, QUAESTOR_ABI, owner)
    : null;

  const lastSpendByIp = new Map<string, number>();
  const lastAgentByIp = new Map<string, number>();
  let daySpends = 0;
  let dayAgents = 0;
  let dayStart = Date.now();

  const rollDay = () => {
    if (Date.now() - dayStart > 24 * 3600_000) {
      daySpends = 0;
      dayAgents = 0;
      dayStart = Date.now();
    }
  };

  const ipOf = (req: any): string =>
    (req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.ip ?? "?").trim();

  app.get("/api/demo/spend", async (req, res) => {
    rollDay();
    const ip = ipOf(req);
    const last = lastSpendByIp.get(ip) ?? 0;
    if (Date.now() - last < SPEND_COOLDOWN_MS) {
      return res.status(429).json({
        error: "one demo spend per minute per visitor — the governor teaches patience",
      });
    }
    if (daySpends >= MAX_SPENDS_PER_DAY) {
      return res.status(429).json({ error: "daily demo budget exhausted, back tomorrow" });
    }
    lastSpendByIp.set(ip, Date.now());
    daySpends++;

    try {
      const quote = await fetch(`${cfg.oracleBase}/quote`).then((r) => r.json());
      const meta: DecisionMeta = {
        agent: "Proba (public demo)",
        action: "demo-buy-signal",
        rationale:
          "a visitor asked to see a governed spend: pay the oracle for one market signal, within Proba's on-chain caps",
        inputs: { visitor: "curl", priceWei: quote.priceWei },
        timestamp: new Date().toISOString(),
      };
      const { txHash, metaHash } = await proba.pay(
        cfg.probaAgentId,
        Category.DATA,
        quote.payee,
        BigInt(quote.priceWei),
        meta
      );
      const signal = await fetch(`${cfg.oracleBase}/signal`, {
        headers: { "x-quaestor-tx": txHash },
      }).then((r) => r.json());
      const remaining = await proba.remainingBudget(cfg.probaAgentId, Category.DATA);

      res.json({
        what_just_happened:
          "The demo agent paid the oracle on-chain through the Quaestor governor, redeemed the receipt for a market signal, and committed a hash of its rationale — all within caps its owner set.",
        receipt: {
          tx: txHash,
          explorer: `${cfg.explorerTx}${txHash}`,
          decision_hash: metaHash,
          paid_okb: ethers.formatEther(BigInt(quote.priceWei)),
        },
        signal: signal.signal ?? signal,
        budget_after: {
          data_remaining_okb: ethers.formatEther(remaining),
          note: "when this hits zero, the chain refuses the next spend — no server involved",
        },
        verify_yourself: `${cfg.oracleBase}/decisions/${metaHash}`,
        dashboard: "https://quaestor-app.onrender.com/#/app",
      });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (/EpochCapExceeded/.test(msg)) {
        return res.status(402).json({
          the_point_exactly:
            "Proba's DATA budget for this epoch is spent. The chain just refused the spend — this is the product working. Budget resets within the hour.",
        });
      }
      res.status(500).json({ error: msg.slice(0, 200) });
    }
  });

  app.post("/api/demo/agent", async (req, res) => {
    rollDay();
    if (!owner || !quaestorAsOwner) {
      return res.status(503).json({ error: "visitor agents disabled (no demo owner key)" });
    }
    const ip = ipOf(req);
    const last = lastAgentByIp.get(ip) ?? 0;
    if (Date.now() - last < AGENT_COOLDOWN_MS) {
      return res.status(429).json({ error: "one demo agent per 10 minutes per visitor" });
    }
    if (dayAgents >= MAX_AGENTS_PER_DAY) {
      return res.status(429).json({ error: "daily demo-agent budget exhausted, back tomorrow" });
    }
    lastAgentByIp.set(ip, Date.now());
    dayAgents++;

    try {
      const operatorWallet = ethers.Wallet.createRandom();
      const tx = await quaestorAsOwner.registerAgent(
        operatorWallet.address,
        VISITOR_EPOCH_S,
        JSON.stringify({ name: `Visitor demo ${new Date().toISOString().slice(0, 10)}` }),
        VISITOR_POLICY.data,
        VISITOR_POLICY.inference,
        VISITOR_POLICY.execution,
        { value: VISITOR_DEPOSIT }
      );
      const rcpt = await tx.wait();
      const registered = rcpt.logs
        .map((l: any) => {
          try {
            return quaestorAsOwner.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "AgentRegistered");
      const agentId = registered?.args.agentId?.toString();

      const gasTx = await owner.sendTransaction({
        to: operatorWallet.address,
        value: VISITOR_GAS,
      });
      await gasTx.wait();

      res.json({
        agent_id: agentId,
        operator_address: operatorWallet.address,
        operator_key: operatorWallet.privateKey,
        note: "This key can spend ONLY through the governor, only within dust caps, and the treasury owner is the demo service — that is the whole point.",
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
        watch: "https://quaestor-app.onrender.com/#/app",
        register_tx: `${cfg.explorerTx}${rcpt.hash}`,
      });
    } catch (err) {
      res.status(500).json({ error: ((err as Error).message ?? "").slice(0, 200) });
    }
  });

  app.get("/api/demo/status", async (_req, res) => {
    rollDay();
    try {
      const remaining = await proba.remainingBudget(cfg.probaAgentId, Category.DATA);
      res.json({
        proba_agent_id: cfg.probaAgentId.toString(),
        proba_data_remaining_okb: ethers.formatEther(remaining),
        demo_spends_today: daySpends,
        demo_agents_today: dayAgents,
        visitor_agents_enabled: Boolean(owner),
      });
    } catch (err) {
      res.status(500).json({ error: ((err as Error).message ?? "").slice(0, 160) });
    }
  });

  console.log(
    `[demo] mounted — Proba #${cfg.probaAgentId}, visitor agents ${owner ? "ENABLED" : "disabled"}`
  );
}
