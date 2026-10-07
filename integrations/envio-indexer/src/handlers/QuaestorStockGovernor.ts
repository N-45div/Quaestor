/*
 * Each governor: the trades it let through, with what left the budget and what arrived, and every
 * change its owner made to the rules. Running totals per governor, agent, token and day are kept
 * as each trade lands, so a query never has to add up the history.
 */
import { BigDecimal, indexer } from "envio";
import { BUDGET_DECIMALS, DAY, symbolOf } from "../monad";

const fields = { transaction: ["hash"], block: ["timestamp"] } as const;

/** One change to the rules, kept in order with what it set. */
const change = (
  context: { PolicyChange: { set: (e: { id: string; governor_id: string; kind: string; detail: string; timestamp: number; txHash: string }) => void } },
  event: { srcAddress: string; logIndex: number; block: { timestamp: number }; transaction: { hash: string } },
  kind: string,
  detail: Record<string, string | number | boolean>,
) =>
  context.PolicyChange.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    governor_id: event.srcAddress.toLowerCase(),
    kind,
    detail: JSON.stringify(detail),
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });

const instrumentId = (governor: string, token: string) => `${governor.toLowerCase()}-${token.toLowerCase()}`;

const instrumentDefaults = (governor: string, token: string) => ({
  id: instrumentId(governor, token),
  governor_id: governor.toLowerCase(),
  token: token.toLowerCase(),
  symbol: symbolOf(token),
  allowed: false,
  decimals: 18,
  maxPrice: 0n,
  feed: undefined,
  maxDeviationBps: undefined,
  maxStaleness: undefined,
  bought: 0n,
  spent: 0n,
  tradeCount: 0,
});

indexer.onEvent({ contract: "QuaestorStockGovernor", event: "TradeExecuted", fields }, async ({ event, context }) => {
  const governorId = event.srcAddress.toLowerCase();
  const governor = await context.Governor.getOrThrow(governorId);
  const { spent, received } = event.params;
  const instrument = await context.Instrument.getOrCreate(instrumentDefaults(governorId, event.params.tokenOut));
  const price = received > 0n
    ? new BigDecimal(spent.toString()).div(new BigDecimal(10).pow(BUDGET_DECIMALS)).div(new BigDecimal(received.toString()).div(new BigDecimal(10).pow(instrument.decimals)))
    : new BigDecimal(0);

  context.Trade.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    governor_id: governorId,
    agent_id: governor.agent_id,
    instrument_id: instrument.id,
    intentId: event.params.intentId,
    venue: event.params.venue.toLowerCase(),
    symbol: instrument.symbol,
    spent,
    received,
    pricePerToken: price,
    decisionHash: event.params.decisionHash,
    epoch: event.params.epoch,
    spentInEpoch: event.params.spentInEpoch,
    block: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  context.Governor.set({ ...governor, tradeCount: governor.tradeCount + 1, spent: governor.spent + spent, lastTradeAt: event.block.timestamp });
  context.Instrument.set({ ...instrument, bought: instrument.bought + received, spent: instrument.spent + spent, tradeCount: instrument.tradeCount + 1 });
  const agent = await context.Agent.getOrThrow(governor.agent_id);
  context.Agent.set({ ...agent, tradeCount: agent.tradeCount + 1, spent: agent.spent + spent });
  const day = Math.floor(event.block.timestamp / DAY);
  const daily = await context.DailyVolume.getOrCreate({ id: String(day), day, tradeCount: 0, spent: 0n });
  context.DailyVolume.set({ ...daily, tradeCount: daily.tradeCount + 1, spent: daily.spent + spent });
});

indexer.onEvent({ contract: "QuaestorStockGovernor", event: "PolicySet", fields }, async ({ event, context }) => {
  const governor = await context.Governor.getOrThrow(event.srcAddress.toLowerCase());
  const { perTradeCap, epochCap, epochLength } = event.params;
  context.Governor.set({ ...governor, perTradeCap, epochCap, epochLength });
  change(context, event, "policy", { perTradeCap: perTradeCap.toString(), epochCap: epochCap.toString(), epochLength: epochLength.toString() });
});

indexer.onEvent({ contract: "QuaestorStockGovernor", event: "SuspendedSet", fields }, async ({ event, context }) => {
  const governor = await context.Governor.getOrThrow(event.srcAddress.toLowerCase());
  context.Governor.set({ ...governor, suspended: event.params.suspended });
  change(context, event, "suspended", { suspended: event.params.suspended, by: event.params.by.toLowerCase() });
});

indexer.onEvent({ contract: "QuaestorStockGovernor", event: "InstrumentSet", fields }, async ({ event, context }) => {
  const instrument = await context.Instrument.getOrCreate(instrumentDefaults(event.srcAddress, event.params.token));
  context.Instrument.set({ ...instrument, allowed: event.params.allowed, decimals: Number(event.params.decimals) });
  change(context, event, "instrument", { token: symbolOf(event.params.token), allowed: event.params.allowed });
});

indexer.onEvent({ contract: "QuaestorStockGovernor", event: "PriceLimitSet", fields }, async ({ event, context }) => {
  const instrument = await context.Instrument.getOrCreate(instrumentDefaults(event.srcAddress, event.params.token));
  context.Instrument.set({ ...instrument, maxPrice: event.params.maxPrice });
  change(context, event, "limit", { token: symbolOf(event.params.token), maxPrice: event.params.maxPrice.toString() });
});

indexer.onEvent({ contract: "QuaestorStockGovernor", event: "PriceGuardSet", fields }, async ({ event, context }) => {
  const instrument = await context.Instrument.getOrCreate(instrumentDefaults(event.srcAddress, event.params.token));
  const { feed, maxDeviationBps, maxStaleness } = event.params;
  context.Instrument.set({ ...instrument, feed: feed.toLowerCase(), maxDeviationBps: Number(maxDeviationBps), maxStaleness: Number(maxStaleness) });
  change(context, event, "guard", { token: symbolOf(event.params.token), feed: feed.toLowerCase(), maxDeviationBps: Number(maxDeviationBps), maxStaleness: Number(maxStaleness) });
});

indexer.onEvent({ contract: "QuaestorStockGovernor", event: "Withdrawn", fields }, async ({ event, context }) => {
  change(context, event, "withdrawn", { token: symbolOf(event.params.token), to: event.params.to.toLowerCase(), amount: event.params.amount.toString() });
});
