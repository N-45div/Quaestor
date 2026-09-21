import { expect } from "chai";
import express from "express";
import type { Server } from "node:http";
import { mountDiscovery, type DiscoveryInfo } from "../services/discovery";

/**
 * The agent card another agent reads before paying. On mainnet it must quote
 * the oracle's real price in the chain's own unit, and it must not point at a
 * route that spends real money for whoever calls it.
 */
describe("discovery — the agent card", () => {
  let server: Server;
  afterEach(() => server?.close());

  const base: DiscoveryInfo = {
    baseUrl: "https://hub.example",
    quaestorAddress: "0x2e91d035D622d2ECa36B7836CBcf9651711B2D10",
    network: "eip155:8453",
    x402Network: "eip155:196",
    price: "0.000002",
    symbol: "ETH",
    signalSource: "Uniswap v3 ETH/USDC 0.30% on Base",
    collector: "0xD486faaa06a5630Ab1c61519011584df5F07e7DD",
    x402Enabled: false,
    x402Price: "$0.01",
    starter: false,
  };

  async function card(info: DiscoveryInfo) {
    const app = express();
    mountDiscovery(app, info);
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/.well-known/agent.json`);
    return (await res.json()) as { description: string; payments: { price: string }[]; extras: Record<string, string> };
  }

  it("quotes the oracle's own price and unit, and names where the signal comes from", async () => {
    const body = await card(base);
    expect(body.payments[0].price).to.equal("0.000002 ETH");
    expect(body.description).to.contain("Uniswap v3 ETH/USDC");
    expect(body.description).not.to.contain("X Layer");
  });

  it("points liveness at the health check and leaves out the spend-on-demand routes when they are not mounted", async () => {
    const body = await card(base);
    expect(body.extras.liveness).to.equal("https://hub.example/healthz");
    expect(body.extras).not.to.have.property("heartbeat");
    expect(body.extras).not.to.have.property("starterTreasury");
  });

  it("advertises the heartbeat and the starter only where they are mounted", async () => {
    const body = await card({ ...base, starter: true });
    expect(body.extras.heartbeat).to.equal("https://hub.example/api/heartbeat");
    expect(body.extras.starterTreasury).to.equal("https://hub.example/api/starter/claim");
  });
});
