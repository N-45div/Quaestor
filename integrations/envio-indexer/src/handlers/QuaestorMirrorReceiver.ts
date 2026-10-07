/*
 * The Chainlink CRE receiver: each stock price the workflow wrote onto Monad, and each it skipped
 * because the mirror already held as fresh a round. The latest per symbol is what a governor's
 * price guard is reading right now.
 */
import { indexer } from "envio";
import { bytes32ToText } from "../monad";

const fields = { transaction: ["hash"], block: ["timestamp"] } as const;

indexer.onEvent({ contract: "QuaestorMirrorReceiver", event: "Relayed", fields }, async ({ event, context }) => {
  const symbol = bytes32ToText(event.params.symbol);
  const feed = await context.Feed.getOrCreate({ id: symbol, answer: 0n, sourceUpdatedAt: 0n, writes: 0, skips: 0, lastWriteAt: 0 });
  context.Feed.set({ ...feed, answer: event.params.answer, sourceUpdatedAt: event.params.sourceUpdatedAt, writes: feed.writes + 1, lastWriteAt: event.block.timestamp });
  context.PriceWrite.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    feed_id: symbol,
    answer: event.params.answer,
    sourceUpdatedAt: event.params.sourceUpdatedAt,
    skipped: false,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
});

indexer.onEvent({ contract: "QuaestorMirrorReceiver", event: "Skipped", fields }, async ({ event, context }) => {
  const symbol = bytes32ToText(event.params.symbol);
  const feed = await context.Feed.getOrCreate({ id: symbol, answer: 0n, sourceUpdatedAt: 0n, writes: 0, skips: 0, lastWriteAt: 0 });
  context.Feed.set({ ...feed, skips: feed.skips + 1 });
  context.PriceWrite.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    feed_id: symbol,
    answer: feed.answer,
    sourceUpdatedAt: event.params.sourceUpdatedAt,
    skipped: true,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
});
