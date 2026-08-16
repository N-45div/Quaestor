import type { Express } from "express";

/**
 * Agent-facing discovery: /.well-known/agent.json (A2A-style agent card).
 * The minimum surface another agent needs to find, price, and pay this
 * service — both payment lanes advertised.
 */

export interface DiscoveryInfo {
  baseUrl: string;
  quaestorAddress: string;
  network: string;
  priceOkb: string;
  collector: string;
  x402Enabled: boolean;
  x402Price: string;
}

export function mountDiscovery(app: Express, info: DiscoveryInfo): void {
  const card = {
    name: "Quaestor Oracle",
    description:
      "Paid market-signal API (spot/SMA/momentum from QuaestorDEX on X Layer), with governed on-chain settlement. Run by Quaestor — the spend governor for AI agents: purpose-scoped budgets, a receipt for every decision, a guardian that can stop but never spend.",
    url: info.baseUrl,
    provider: {
      organization: "Quaestor",
      url: "https://github.com/N-45div/Quaestor",
    },
    version: "0.1.0",
    capabilities: { streaming: false, pushNotifications: false },
    skills: [
      {
        id: "market-signal",
        name: "Market signal",
        description:
          "Spot price, SMA and momentum for qUSD/OKB, sampled from on-chain reserves.",
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
    payments: [
      {
        scheme: "quaestor-governed",
        network: info.network,
        description:
          "Pay through the Quaestor governor (contract " +
          info.quaestorAddress +
          "): call pay(agentId, DATA, payee, amount, metaHash), then GET /signal with header x-quaestor-tx: <txHash>. One receipt redeems one response. Discovery: GET /quote.",
        payTo: info.collector,
        price: `${info.priceOkb} OKB`,
        endpoints: { quote: "/quote", resource: "/signal" },
      },
      ...(info.x402Enabled
        ? [
            {
              scheme: "exact",
              protocol: "x402",
              network: info.network,
              description: "Standard x402 via OKX facilitator.",
              payTo: info.collector,
              price: info.x402Price,
              endpoints: { resource: "/x402/signal" },
            },
          ]
        : []),
    ],
    extras: {
      liveness: `${info.baseUrl}/api/heartbeat`,
      starterTreasury: `${info.baseUrl}/api/starter/claim`,
      dashboard: "https://quaestor-app.onrender.com",
    },
  };

  app.get("/.well-known/agent.json", (_req, res) => res.json(card));
  console.log("[discovery] mounted — /.well-known/agent.json");
}
