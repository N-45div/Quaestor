#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ethers } from "ethers";
import * as dotenv from "dotenv";
import { Category, QuaestorAgent, DEX_ABI, type DecisionMeta } from "../sdk";
import { budgetSourceFromEnv } from "../services/graph";

dotenv.config();

/**
 * Quaestor MCP server — the governed treasury as tools.
 *
 * Give an LLM agent this server and an operator key, and every coin it can
 * move is bounded by on-chain caps its owner set. The operator key is the
 * only wallet key it is rational to hand to a model: it cannot withdraw the
 * treasury, cannot change policy, and cannot resume a suspended agent. The
 * blast radius is a number — printed at startup.
 *
 * Design rules (deliberate):
 *  - stdout is the protocol; ALL human logging goes to stderr.
 *  - `rationale` is REQUIRED on every spending tool — it becomes the
 *    keccak-committed decision record on-chain.
 *  - Errors teach: cap rejections explain what remains and when it resets.
 *  - No owner tools. Registration, funding, caps, resume live in the
 *    dashboard where a human is present.
 */

const log = (msg: string) => console.error(`[quaestor-mcp] ${msg}`);

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[quaestor-mcp] missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

const RPC_URL =
  process.env.RPC_URL ?? process.env.XLAYER_TESTNET_RPC ?? "https://testrpc.xlayer.tech";
const QUAESTOR_ADDRESS = required("QUAESTOR_ADDRESS");
const DEX_ADDRESS = process.env.DEX_ADDRESS ?? "";
const AGENT_ID = BigInt(required("AGENT_ID"));
const OPERATOR_KEY = required("OPERATOR_KEY");
const LEDGER_URL = process.env.DECISION_LEDGER_URL ?? "";
const EXPLORER_TX = process.env.EXPLORER_TX ?? "https://www.oklink.com/xlayer-test/tx/";
const GUARDIAN_KEY = process.env.GUARDIAN_KEY;

const AGENT_NAME = process.env.AGENT_NAME ?? `agent-${AGENT_ID}`;
const CATEGORY_NAMES = ["DATA", "INFERENCE", "EXECUTION"] as const;

const sdk = new QuaestorAgent({
  rpcUrl: RPC_URL,
  quaestorAddress: QUAESTOR_ADDRESS,
  dexAddress: DEX_ADDRESS || undefined,
  privateKey: OPERATOR_KEY,
  decisionLedgerUrl: LEDGER_URL || undefined,
});
const dex = DEX_ADDRESS ? new ethers.Contract(DEX_ADDRESS, DEX_ABI, sdk.provider) : null;

// Spend history for quaestor_budget. Falls back to the governor when the index
// is stale, which keeps caps exact and honestly drops the history.
const BUDGETS = budgetSourceFromEnv(sdk.provider, QUAESTOR_ADDRESS);

const okb = (wei: bigint) => ethers.formatEther(wei);
const meta = (action: string, rationale: string, inputs: Record<string, unknown>): DecisionMeta => ({
  agent: AGENT_NAME,
  action,
  rationale,
  inputs,
  timestamp: new Date().toISOString(),
});

// ---------------------------------------------------------------- status

interface CategoryStatus {
  purpose: (typeof CATEGORY_NAMES)[number];
  per_epoch_cap_okb: string;
  spent_this_epoch_okb: string;
  remaining_okb: string;
  per_action_cap_okb: string;
}

async function statusOf() {
  const info = await sdk.quaestor.agents(AGENT_ID);
  const [balance, epoch] = await Promise.all([
    sdk.quaestor.balanceOf(AGENT_ID),
    sdk.quaestor.currentEpoch(AGENT_ID),
  ]);
  const categories: CategoryStatus[] = await Promise.all(
    [0, 1, 2].map(async (cat) => {
      const [policy, spentRaw] = await Promise.all([
        sdk.quaestor.policyOf(AGENT_ID, cat),
        sdk.quaestor.spentIn(AGENT_ID, cat, epoch),
      ]);
      const epochCap = BigInt(policy.epochCap);
      const perCallCap = BigInt(policy.perCallCap);
      const spent = BigInt(spentRaw);
      const remaining = epochCap > spent ? epochCap - spent : 0n;
      return {
        purpose: CATEGORY_NAMES[cat],
        per_epoch_cap_okb: okb(epochCap),
        spent_this_epoch_okb: okb(spent),
        remaining_okb: okb(remaining),
        per_action_cap_okb: okb(perCallCap),
      };
    })
  );
  const epochLength = Number(info.epochLength);
  const elapsed = (Math.floor(Date.now() / 1000) - Number(info.registeredAt)) % epochLength;
  const resetsInS = epochLength - elapsed;
  return {
    agent_id: AGENT_ID.toString(),
    name: AGENT_NAME,
    suspended: info.suspended as boolean,
    treasury_okb: okb(balance),
    epoch: {
      index: Number(epoch),
      length_seconds: epochLength,
      resets_in: `${Math.floor(resetsInS / 3600)}h ${Math.floor((resetsInS % 3600) / 60)}m`,
    },
    budgets: categories,
    owner: info.owner as string,
  };
}

// ---------------------------------------------------------- teaching errors

async function explainError(err: unknown): Promise<string> {
  const e = err as any;
  const data = e?.data ?? e?.info?.error?.data;
  let name: string | null = null;
  let args: any = null;
  if (typeof data === "string") {
    try {
      const parsed = sdk.quaestor.interface.parseError(data);
      name = parsed?.name ?? null;
      args = parsed?.args ?? null;
    } catch {
      /* not one of ours */
    }
  }
  const s = await statusOf().catch(() => null);
  const reset = s ? s.epoch.resets_in : "the next epoch";

  switch (name) {
    case "PerCallCapExceeded":
      return `PER_ACTION_CAP_EXCEEDED: you asked to spend ${okb(args[0])} OKB but this category's per-action cap is ${okb(args[1])} OKB. Split the spend or stay under the cap. This limit is on-chain; retrying the same amount will fail identically.`;
    case "EpochCapExceeded":
      return `EPOCH_CAP_EXCEEDED: this spend would bring the category's epoch total to ${okb(args[0])} OKB, above its cap of ${okb(args[1])} OKB. Remaining budgets: ${s ? s.budgets.map((b) => `${b.purpose} ${b.remaining_okb}`).join(", ") : "unknown"}. The epoch resets in ${reset}. Options: wait for the reset, use a different purpose only if genuinely appropriate, or stop and report the cap to your principal.`;
    case "AgentIsSuspended":
      return `AGENT_SUSPENDED: the owner or guardian froze this agent. Only the owner can resume it (from the dashboard). Do not retry; stand down and report.`;
    case "InsufficientTreasury":
      return `INSUFFICIENT_TREASURY: the treasury holds ${args ? okb(args[1]) : "?"} OKB but the spend needs ${args ? okb(args[0]) : "?"}. Only the owner can deposit more. Stand down and report.`;
    case "InvalidCategory":
      return `WRONG_PURPOSE: EXECUTION spends must use quaestor_swap, not quaestor_pay.`;
    case "NotOperator":
      return `NOT_OPERATOR: this key is not the agent's operator. Check AGENT_ID and OPERATOR_KEY.`;
    default:
      return `ERROR: ${(e?.shortMessage ?? e?.message ?? String(err)).slice(0, 240)}`;
  }
}

const jsonResult = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
});
const errorResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

// ------------------------------------------------------------------ server

const server = new McpServer({ name: "quaestor", version: "0.1.0" });

server.registerTool(
  "quaestor_agent_status",
  {
    description:
      "Your governed treasury's live state: balance, per-purpose budgets (DATA/INFERENCE/EXECUTION), what's spent and remaining this epoch, and when budgets reset. Call this BEFORE spending so you know what you can afford. Read-only.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await statusOf());
    } catch (e) {
      return errorResult(await explainError(e));
    }
  }
);

server.registerTool(
  "quaestor_pay_url",
  {
    description:
      "Fetch a paid HTTP resource end-to-end: request the URL, and if it answers 402 Payment Required with Quaestor settlement details, pay through the governor (within your caps), then retry with the payment receipt and return the body. Use for paid APIs like the Quaestor oracle. The rationale you give is hash-committed on-chain with the payment and publicly auditable.",
    inputSchema: {
      url: z.string().describe("The paid resource URL, e.g. https://…/signal"),
      purpose: z
        .enum(["DATA", "INFERENCE"])
        .describe("Budget purpose: DATA for external data/APIs, INFERENCE for model costs"),
      max_amount_okb: z
        .string()
        .describe("Your own ceiling for this payment in OKB, e.g. '0.001' — on top of on-chain caps"),
      rationale: z
        .string()
        .min(10)
        .describe("Why you are spending this — becomes the on-chain decision record"),
      dry_run: z.boolean().optional().describe("If true, report what would happen without paying"),
    },
  },
  async ({ url, purpose, max_amount_okb, rationale, dry_run }) => {
    try {
      const first = await fetch(url);
      if (first.ok) {
        return jsonResult({
          note: "resource was free — no payment needed",
          status: first.status,
          body: await first.text().then((t) => t.slice(0, 4000)),
        });
      }
      if (first.status !== 402) {
        return errorResult(`Resource returned ${first.status}, not 402 — nothing to pay.`);
      }
      const challenge = (await first.json()) as { priceWei?: string; payee?: string };
      if (!challenge.priceWei || !challenge.payee) {
        return errorResult(
          "402 received but no Quaestor settlement details (priceWei/payee) found in the body."
        );
      }
      const price = BigInt(challenge.priceWei);
      const ceiling = ethers.parseEther(max_amount_okb);
      if (price > ceiling) {
        return errorResult(
          `PRICE_ABOVE_YOUR_CEILING: the resource costs ${okb(price)} OKB but your max_amount_okb is ${max_amount_okb}. Raise your ceiling only if the spend is truly justified.`
        );
      }
      if (dry_run) {
        return jsonResult({
          dry_run: true,
          would_pay_okb: okb(price),
          payee: challenge.payee,
          purpose,
        });
      }
      const cat = purpose === "DATA" ? Category.DATA : Category.INFERENCE;
      const { txHash, metaHash } = await sdk.pay(
        AGENT_ID,
        cat,
        challenge.payee,
        price,
        meta("pay-url", rationale, { url, priceWei: challenge.priceWei })
      );
      const second = await fetch(url, { headers: { "x-quaestor-tx": txHash } });
      const body = await second.text();
      const s = await statusOf().catch(() => null);
      return jsonResult({
        status: second.status,
        body: body.slice(0, 4000),
        paid_okb: okb(price),
        receipt: {
          tx: txHash,
          explorer: `${EXPLORER_TX}${txHash}`,
          decision_hash: metaHash,
        },
        budget_after: s?.budgets.find((b) => b.purpose === purpose),
      });
    } catch (e) {
      return errorResult(await explainError(e));
    }
  }
);

server.registerTool(
  "quaestor_pay",
  {
    description:
      "Pay an address directly from the governed treasury (DATA or INFERENCE purpose), within on-chain caps. The rationale is hash-committed on-chain with the payment. For paid URLs prefer quaestor_pay_url; for trades use quaestor_swap.",
    inputSchema: {
      purpose: z.enum(["DATA", "INFERENCE"]),
      recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      amount_okb: z.string().describe("Amount in OKB, e.g. '0.0005'"),
      rationale: z.string().min(10),
      dry_run: z.boolean().optional(),
    },
  },
  async ({ purpose, recipient, amount_okb, rationale, dry_run }) => {
    try {
      const amount = ethers.parseEther(amount_okb);
      if (dry_run) {
        const s = await statusOf();
        return jsonResult({
          dry_run: true,
          would_pay_okb: amount_okb,
          budget: s.budgets.find((b) => b.purpose === purpose),
          suspended: s.suspended,
        });
      }
      const cat = purpose === "DATA" ? Category.DATA : Category.INFERENCE;
      const { txHash, metaHash } = await sdk.pay(
        AGENT_ID,
        cat,
        recipient,
        amount,
        meta("pay", rationale, { recipient, amount_okb })
      );
      const s = await statusOf().catch(() => null);
      return jsonResult({
        paid_okb: amount_okb,
        receipt: { tx: txHash, explorer: `${EXPLORER_TX}${txHash}`, decision_hash: metaHash },
        budget_after: s?.budgets.find((b) => b.purpose === purpose),
      });
    } catch (e) {
      return errorResult(await explainError(e));
    }
  }
);

server.registerTool(
  "quaestor_swap",
  {
    description:
      "Swap native OKB for a token through the DEX, governed by the EXECUTION budget. Slippage-protected. The rationale is hash-committed on-chain with the trade.",
    inputSchema: {
      token_out: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      amount_in_okb: z.string(),
      max_slippage_bps: z.number().int().min(1).max(2000).optional().describe("default 100 (1%)"),
      rationale: z.string().min(10),
      dry_run: z.boolean().optional(),
    },
  },
  async ({ token_out, amount_in_okb, max_slippage_bps, rationale, dry_run }) => {
    try {
      if (!dex) return errorResult("No DEX_ADDRESS configured for this server.");
      const amountIn = ethers.parseEther(amount_in_okb);
      const expected: bigint = await dex.getNativeToTokenOut(token_out, amountIn);
      const bps = BigInt(max_slippage_bps ?? 100);
      const minOut = (expected * (10_000n - bps)) / 10_000n;
      if (dry_run) {
        const s = await statusOf();
        return jsonResult({
          dry_run: true,
          amount_in_okb,
          expected_out: expected.toString(),
          min_out: minOut.toString(),
          budget: s.budgets.find((b) => b.purpose === "EXECUTION"),
        });
      }
      const { txHash, metaHash } = await sdk.swap(
        AGENT_ID,
        amountIn,
        minOut,
        token_out,
        meta("swap", rationale, {
          token_out,
          amount_in_okb,
          expected_out: expected.toString(),
        })
      );
      const s = await statusOf().catch(() => null);
      return jsonResult({
        swapped_okb: amount_in_okb,
        min_tokens_out: ethers.formatEther(minOut),
        receipt: { tx: txHash, explorer: `${EXPLORER_TX}${txHash}`, decision_hash: metaHash },
        budget_after: s?.budgets.find((b) => b.purpose === "EXECUTION"),
      });
    } catch (e) {
      return errorResult(await explainError(e));
    }
  }
);

server.registerTool(
  "quaestor_receipts",
  {
    description:
      "Recent on-chain receipts for this agent — every governed spend with amount, purpose, payee, and the committed decision hash. Read-only.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional().describe("default 10"),
    },
  },
  async ({ limit }) => {
    try {
      if (!LEDGER_URL) return errorResult("No DECISION_LEDGER_URL configured.");
      const res = await fetch(`${LEDGER_URL}/receipts`);
      const body = (await res.json()) as { receipts: any[] };
      const mine = (body.receipts ?? [])
        .filter((r) => r.agentId === AGENT_ID.toString())
        .slice(0, limit ?? 10)
        .map((r) => ({
          purpose: CATEGORY_NAMES[r.category] ?? r.category,
          amount_okb: ethers.formatEther(BigInt(r.amount)),
          payee: r.payee,
          decision_hash: r.metaHash,
          tx: r.txHash,
          explorer: `${EXPLORER_TX}${r.txHash}`,
          at: new Date(r.timestamp).toISOString(),
        }));
      return jsonResult({ receipts: mine });
    } catch (e) {
      return errorResult(await explainError(e));
    }
  }
);

server.registerTool(
  "quaestor_budget",
  {
    description:
      "Your own budget and how you have been spending it: caps, what is left this epoch, and — from the subgraph — the largest single payment you have ever made, your busiest epoch, and how many payments make up this one. Ask before a spend you are unsure about. The shape figures have no on-chain equivalent, so if the index is stale this says so rather than guessing.",
    inputSchema: {
      purpose: z.enum(CATEGORY_NAMES).optional().describe("default EXECUTION"),
    },
  },
  async ({ purpose }) => {
    try {
      if (!BUDGETS) {
        return errorResult(
          "No budget source configured. Set SUBGRAPH_URL for spend history, or rely on quaestor_status for caps."
        );
      }
      const category = CATEGORY_NAMES.indexOf(purpose ?? "EXECUTION");
      const b = await BUDGETS.budget(AGENT_ID.toString(), category);
      const fmt = (v: bigint) => ethers.formatEther(v);

      return jsonResult({
        purpose: b.categoryName,
        epoch: b.currentEpoch,
        per_call_cap: fmt(b.perCallCap),
        remaining_this_epoch: fmt(b.remaining),
        spent_this_epoch: fmt(b.spentThisEpoch),
        source: b.source,
        // Absent means the fallback answered — the caps above are still exact,
        // but nothing can tell you whether a spend is unusual for you.
        history: b.shape
          ? {
              epochs_on_record: b.shape.epochsSeen,
              payments_this_epoch: b.shape.receiptCountThisEpoch,
              largest_this_epoch: fmt(b.shape.maxReceiptThisEpoch),
              largest_ever: fmt(b.shape.maxPriorReceipt),
              busiest_epoch_payments: b.shape.maxPriorReceiptCount,
              heaviest_epoch: fmt(b.shape.maxPriorEpochSpend),
              incomplete: b.shape.truncated || undefined,
            }
          : null,
        note: b.shape
          ? undefined
          : "Spend history unavailable (the index is stale or unreachable), so I cannot tell you whether a spend would be unusual — only that it fits the caps.",
      });
    } catch (e) {
      return errorResult(await explainError(e));
    }
  }
);

server.registerTool(
  "quaestor_verify_receipt",
  {
    description:
      "Verify a decision record against its on-chain commitment: fetches the published record for a decision hash (or takes one you provide) and recomputes keccak-256 locally. Use it to audit your own past spends — or another agent's.",
    inputSchema: {
      decision_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      decision_record: z
        .string()
        .optional()
        .describe("Optional raw record JSON string; fetched from the ledger when omitted"),
    },
  },
  async ({ decision_hash, decision_record }) => {
    try {
      let raw = decision_record;
      if (!raw) {
        if (!LEDGER_URL) return errorResult("No DECISION_LEDGER_URL configured and no record given.");
        const res = await fetch(`${LEDGER_URL}/decisions/${decision_hash.toLowerCase()}`);
        if (res.status === 404) {
          return jsonResult({
            match: null,
            note: "Record not published. The hash still binds the operator: any record produced later must match it byte-for-byte.",
          });
        }
        raw = await res.text();
      }
      const computed = ethers.keccak256(ethers.toUtf8Bytes(raw));
      const match = computed.toLowerCase() === decision_hash.toLowerCase();
      return jsonResult({
        match,
        computed_hash: computed,
        claimed_hash: decision_hash,
        record: match ? JSON.parse(raw) : undefined,
        warning: match ? undefined : "MISMATCH — do not trust this record.",
      });
    } catch (e) {
      return errorResult(await explainError(e));
    }
  }
);

if (GUARDIAN_KEY) {
  const guardianSigner = new ethers.NonceManager(new ethers.Wallet(GUARDIAN_KEY, sdk.provider));
  server.registerTool(
    "quaestor_suspend",
    {
      description:
        "GUARDIAN ONLY: freeze this agent's spending entirely, in one on-chain transaction. Use when spending looks wrong (runaway loop, suspected compromise). There is deliberately NO resume tool — only the human owner can resume, from the dashboard.",
      inputSchema: {
        reason: z.string().min(10).describe("Why you are pulling the kill-switch"),
      },
    },
    async ({ reason }) => {
      try {
        const quaestorAsGuardian = sdk.quaestor.connect(guardianSigner) as ethers.Contract;
        const tx = await quaestorAsGuardian.suspend(AGENT_ID);
        await tx.wait();
        log(`guardian suspended agent #${AGENT_ID}: ${reason}`);
        return jsonResult({
          suspended: true,
          tx: tx.hash,
          explorer: `${EXPLORER_TX}${tx.hash}`,
          note: "Only the owner can resume, from the dashboard.",
        });
      } catch (e) {
        return errorResult(await explainError(e));
      }
    }
  );
}

// ------------------------------------------------------------------- boot

async function main() {
  // Safety gate: refuse to run with the owner's key. Owner powers must never
  // share a process with the model.
  const info = await sdk.quaestor.agents(AGENT_ID);
  const operatorAddress = await (sdk.signer.signer as ethers.Wallet).getAddress();
  if (operatorAddress.toLowerCase() === (info.owner as string).toLowerCase()) {
    console.error(
      "[quaestor-mcp] REFUSING TO START: the configured key is the agent OWNER. " +
        "Owner powers (withdraw, caps, resume) must never be exposed to a model. " +
        "Use the operator key instead."
    );
    process.exit(1);
  }
  if (operatorAddress.toLowerCase() !== (info.operator as string).toLowerCase()) {
    console.error(
      `[quaestor-mcp] WARNING: configured key ${operatorAddress} is not agent #${AGENT_ID}'s operator (${info.operator}). Spends will revert.`
    );
  }

  const s = await statusOf();
  const totalEpoch = s.budgets.reduce((acc, b) => acc + Number(b.per_epoch_cap_okb), 0);
  log(`operator key active for agent #${AGENT_ID} ("${AGENT_NAME}")`);
  log(
    `blast radius if this key is fully compromised: ${totalEpoch} OKB per epoch ` +
      `(${s.budgets.map((b) => `${b.purpose} ${b.per_epoch_cap_okb}`).join(" / ")}).`
  );
  log(
    "this key cannot withdraw the treasury, change caps, or resume a suspended agent."
  );

  await server.connect(new StdioServerTransport());
  log("connected over stdio");
}

main().catch((err) => {
  console.error("[quaestor-mcp] fatal:", err);
  process.exit(1);
});
