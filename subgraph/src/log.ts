import { Published, Reported } from "../generated/QuaestorLog/QuaestorLog";
import { DecisionRecord, ThreatReport } from "../generated/schema";

/**
 * A decision record, published.
 *
 * The same record may be published more than once — by the agent, by anyone
 * who holds a copy — and every copy has the same hash, because QuaestorLog
 * computes it from the bytes. The first one is kept: the entity is immutable,
 * and a later copy says nothing the first did not.
 */
export function handlePublished(event: Published): void {
  if (DecisionRecord.load(event.params.metaHash) != null) return;
  const record = new DecisionRecord(event.params.metaHash);
  record.recordBytes = event.params.record;
  record.record = event.params.record.toString();
  record.publisher = event.params.publisher;
  record.blockNumber = event.block.number;
  record.timestamp = event.block.timestamp;
  record.transactionHash = event.transaction.hash;
  record.save();
}

/** A threat report, relayed. Kept as reported; who relayed it is a reader's call to trust. */
export function handleReported(event: Reported): void {
  const report = new ThreatReport(event.transaction.hash.concatI32(event.logIndex.toI32()));
  report.venue = event.params.venue;
  report.venueHash = event.params.venueHash;
  report.pattern = event.params.pattern;
  report.humanId = event.params.humanId;
  report.tenantHash = event.params.tenantHash;
  report.reporter = event.params.reporter;
  report.blockNumber = event.block.number;
  report.timestamp = event.block.timestamp;
  report.transactionHash = event.transaction.hash;
  report.save();
}
