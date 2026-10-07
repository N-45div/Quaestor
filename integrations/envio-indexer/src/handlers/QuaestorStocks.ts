/*
 * The factory: each governor it makes is registered for indexing as it is created, and becomes a
 * Governor (with its agent) before its own setup events, which follow in the same transaction.
 */
import { indexer } from "envio";

indexer.contractRegister({ contract: "QuaestorStocks", event: "GovernorCreated" }, async ({ event, context }) => {
  context.chain.QuaestorStockGovernor.add(event.params.governor);
});

indexer.onEvent(
  { contract: "QuaestorStocks", event: "GovernorCreated", fields: { transaction: ["hash"], block: ["timestamp"] } },
  async ({ event, context }) => {
    const agentId = event.params.operator.toLowerCase();
    const agent = await context.Agent.getOrCreate({ id: agentId, governorCount: 0, tradeCount: 0, spent: 0n });
    context.Agent.set({ ...agent, governorCount: agent.governorCount + 1 });
    context.Governor.set({
      id: event.params.governor.toLowerCase(),
      owner: event.params.owner.toLowerCase(),
      agent_id: agentId,
      budgetToken: event.params.budgetToken.toLowerCase(),
      deposit: event.params.deposit,
      createdAt: event.block.timestamp,
      createdTx: event.transaction.hash,
      perTradeCap: 0n,
      epochCap: 0n,
      epochLength: 0n,
      suspended: false,
      tradeCount: 0,
      spent: 0n,
      lastTradeAt: undefined,
    });
  },
);
