import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  AgentRegistered,
  Deposited,
  GuardianChanged,
  InstrumentAllowed,
  OperatorChanged,
  PolicySet,
  Receipt as ReceiptEvent,
  Resumed,
  Suspended,
  SwapExecuted,
  VenueAllowed,
  Withdrawn,
} from "../generated/Quaestor/QuaestorV2";
import {
  Agent,
  EpochSpend,
  Instrument,
  Policy,
  Protocol,
  Receipt,
  Suspension,
  Swap,
  TreasuryMove,
  Venue,
} from "../generated/schema";

// Quaestor's Category enum. An *indexed* Solidity enum is surfaced as a plain
// i32 — only dynamic types (string, bytes, arrays, tuples) get hashed into a
// bytes32 topic — so the value decodes normally and we can label it.
function categoryName(category: i32): string {
  if (category == 0) return "DATA";
  if (category == 1) return "INFERENCE";
  if (category == 2) return "EXECUTION";
  return "UNKNOWN";
}

const PROTOCOL_ID = Bytes.fromI32(1);

function agentKey(agentId: BigInt): Bytes {
  return Bytes.fromByteArray(Bytes.fromBigInt(agentId));
}

function loadProtocol(): Protocol {
  let protocol = Protocol.load(PROTOCOL_ID);
  if (protocol == null) {
    protocol = new Protocol(PROTOCOL_ID);
    protocol.agentCount = BigInt.zero();
    protocol.receiptCount = BigInt.zero();
    protocol.totalSpent = BigInt.zero();
    protocol.lastBlock = BigInt.zero();
  }
  return protocol as Protocol;
}

/**
 * An agent can spend before this subgraph has seen its registration — the
 * startBlock may sit after it, or the governor may have been registered in a
 * block we pruned. Receipts must still be indexed, so create a shell rather
 * than dropping the event on the floor.
 */
function loadOrCreateAgent(agentId: BigInt, timestamp: BigInt, block: BigInt): Agent {
  const id = agentKey(agentId);
  let agent = Agent.load(id);
  if (agent != null) return agent as Agent;

  agent = new Agent(id);
  agent.agentId = agentId;
  agent.owner = Bytes.empty();
  agent.operator = Bytes.empty();
  agent.epochLength = BigInt.zero();
  agent.metadataURI = "";
  agent.suspended = false;
  agent.registeredAt = timestamp;
  agent.registeredBlock = block;
  agent.totalSpent = BigInt.zero();
  agent.receiptCount = BigInt.zero();
  agent.suspensionCount = BigInt.zero();
  agent.treasury = BigInt.zero();
  agent.swapCount = BigInt.zero();

  const protocol = loadProtocol();
  protocol.agentCount = protocol.agentCount.plus(BigInt.fromI32(1));
  protocol.lastBlock = block;
  protocol.save();

  return agent as Agent;
}

export function handleAgentRegistered(event: AgentRegistered): void {
  const agent = loadOrCreateAgent(
    event.params.agentId,
    event.block.timestamp,
    event.block.number,
  );
  agent.owner = event.params.owner;
  agent.operator = event.params.operator;
  // uint32 maps to BigInt, not i32 — the conversion table is asymmetric:
  // uint8/16/24 are i32 but uint32 and wider are BigInt.
  agent.epochLength = event.params.epochLength;
  agent.metadataURI = event.params.metadataURI;
  agent.registeredAt = event.block.timestamp;
  agent.registeredBlock = event.block.number;
  agent.save();
}

export function handlePolicySet(event: PolicySet): void {
  const agent = loadOrCreateAgent(
    event.params.agentId,
    event.block.timestamp,
    event.block.number,
  );
  agent.save();

  const category = event.params.category;
  const id = agent.id.concatI32(category);
  let policy = Policy.load(id);
  if (policy == null) {
    policy = new Policy(id);
    policy.agent = agent.id;
    policy.category = category;
    policy.categoryName = categoryName(category);
  }
  policy.epochCap = event.params.epochCap;
  policy.perCallCap = event.params.perCallCap;
  policy.updatedAt = event.block.timestamp;
  policy.updatedBlock = event.block.number;
  policy.save();
}

export function handleReceipt(event: ReceiptEvent): void {
  const agent = loadOrCreateAgent(
    event.params.agentId,
    event.block.timestamp,
    event.block.number,
  );
  const category = event.params.category;
  const amount = event.params.amount;

  const receipt = new Receipt(
    event.transaction.hash.concatI32(event.logIndex.toI32()),
  );
  receipt.agent = agent.id;
  receipt.category = category;
  receipt.categoryName = categoryName(category);
  receipt.payee = event.params.payee;
  receipt.amount = amount;
  receipt.metaHash = event.params.metaHash;
  // A reference by id, set now though the record is published after the spend
  // settles: it resolves to null until QuaestorLog has it, then to the text.
  receipt.decision = event.params.metaHash;
  receipt.epoch = event.params.epoch;
  receipt.epochSpentAfter = event.params.epochSpentAfter;
  receipt.blockNumber = event.block.number;
  receipt.timestamp = event.block.timestamp;
  receipt.transactionHash = event.transaction.hash;
  receipt.save();

  // `spent` duplicates the on-chain `spentIn` sum on purpose — it makes the
  // epoch enumerable, which a Solidity mapping is not. The rest of this block
  // is what no sum can hold: how many payments, how large the largest, and
  // over what window they arrived.
  const epochId = agent.id
    .concatI32(category)
    .concat(Bytes.fromByteArray(Bytes.fromBigInt(event.params.epoch)));
  let epochSpend = EpochSpend.load(epochId);
  if (epochSpend == null) {
    epochSpend = new EpochSpend(epochId);
    epochSpend.agent = agent.id;
    epochSpend.category = category;
    epochSpend.categoryName = categoryName(category);
    epochSpend.epoch = event.params.epoch;
    epochSpend.spent = BigInt.zero();
    epochSpend.receiptCount = BigInt.zero();
    epochSpend.maxReceipt = BigInt.zero();
    epochSpend.firstAt = event.block.timestamp;
  }
  epochSpend.spent = epochSpend.spent.plus(amount);
  epochSpend.receiptCount = epochSpend.receiptCount.plus(BigInt.fromI32(1));
  if (amount.gt(epochSpend.maxReceipt)) epochSpend.maxReceipt = amount;
  epochSpend.lastAt = event.block.timestamp;
  epochSpend.save();

  agent.totalSpent = agent.totalSpent.plus(amount);
  // A receipt is money leaving the treasury. The amount is what was actually
  // spent, not what was authorised: a swap that returned change emits the
  // smaller figure, so the running balance matches `balanceOf` on chain.
  agent.treasury = agent.treasury.minus(amount);
  agent.receiptCount = agent.receiptCount.plus(BigInt.fromI32(1));
  agent.lastReceiptAt = event.block.timestamp;
  agent.save();

  const protocol = loadProtocol();
  protocol.receiptCount = protocol.receiptCount.plus(BigInt.fromI32(1));
  protocol.totalSpent = protocol.totalSpent.plus(amount);
  protocol.lastReceiptAt = event.block.timestamp;
  protocol.lastBlock = event.block.number;
  protocol.save();
}

export function handleSuspended(event: Suspended): void {
  const agent = loadOrCreateAgent(
    event.params.agentId,
    event.block.timestamp,
    event.block.number,
  );
  agent.suspended = true;
  agent.suspensionCount = agent.suspensionCount.plus(BigInt.fromI32(1));
  agent.save();

  const suspension = new Suspension(
    event.transaction.hash.concatI32(event.logIndex.toI32()),
  );
  suspension.agent = agent.id;
  suspension.by = event.params.by;
  suspension.at = event.block.timestamp;
  suspension.block = event.block.number;
  suspension.transactionHash = event.transaction.hash;
  suspension.save();
}

/**
 * Close the most recent open suspension. `Resumed` carries no reference to the
 * suspension it ends, so the open one is found by walking the agent's
 * suspensions — the derived field is exactly what makes that cheap.
 */
export function handleResumed(event: Resumed): void {
  const agent = loadOrCreateAgent(
    event.params.agentId,
    event.block.timestamp,
    event.block.number,
  );
  agent.suspended = false;
  agent.save();

  const suspensions = agent.suspensions.load();
  let newest: Suspension | null = null;
  for (let i = 0; i < suspensions.length; i++) {
    const candidate = suspensions[i];
    if (candidate.resumedAt !== null) continue;
    if (newest == null || candidate.at.gt((newest as Suspension).at)) {
      newest = candidate;
    }
  }
  if (newest != null) {
    const open = newest as Suspension;
    open.resumedAt = event.block.timestamp;
    open.save();
  }
}

export function handleOperatorChanged(event: OperatorChanged): void {
  const agent = loadOrCreateAgent(
    event.params.agentId,
    event.block.timestamp,
    event.block.number,
  );
  agent.operator = event.params.operator;
  agent.save();
}

export function handleGuardianChanged(event: GuardianChanged): void {
  const agent = loadOrCreateAgent(
    event.params.agentId,
    event.block.timestamp,
    event.block.number,
  );
  agent.guardian = event.params.guardian;
  agent.save();
}

// ------------------------------------------------- what V2 records and V1 did not

/**
 * The owner allowing or revoking a venue.
 *
 * Kept as one row per venue with a change count rather than a row per event:
 * the question an agent asks is "may I route here now", and the history behind
 * that answer is the count and the timestamps. `firstAllowedAt` is never
 * overwritten, so a venue revoked and allowed again still shows when it first
 * entered the allowlist.
 */
export function handleVenueAllowed(event: VenueAllowed): void {
  const agent = loadOrCreateAgent(event.params.agentId, event.block.timestamp, event.block.number);
  agent.save();

  const id = agent.id.concat(event.params.venue);
  let venue = Venue.load(id);
  if (venue == null) {
    venue = new Venue(id);
    venue.agent = agent.id;
    venue.venue = event.params.venue;
    venue.changeCount = BigInt.zero();
    venue.firstAllowedAt = event.block.timestamp;
  }
  venue.allowed = event.params.allowed;
  venue.changeCount = venue.changeCount.plus(BigInt.fromI32(1));
  venue.updatedAt = event.block.timestamp;
  venue.updatedBlock = event.block.number;
  venue.save();
}

/** The owner allowing or revoking a token the agent may end up holding. */
export function handleInstrumentAllowed(event: InstrumentAllowed): void {
  const agent = loadOrCreateAgent(event.params.agentId, event.block.timestamp, event.block.number);
  agent.save();

  const id = agent.id.concat(event.params.token);
  let instrument = Instrument.load(id);
  if (instrument == null) {
    instrument = new Instrument(id);
    instrument.agent = agent.id;
    instrument.token = event.params.token;
    instrument.changeCount = BigInt.zero();
    instrument.firstAllowedAt = event.block.timestamp;
  }
  instrument.allowed = event.params.allowed;
  instrument.changeCount = instrument.changeCount.plus(BigInt.fromI32(1));
  instrument.updatedAt = event.block.timestamp;
  instrument.updatedBlock = event.block.number;
  instrument.save();
}

/**
 * A governed swap that settled.
 *
 * Both amounts are the contract's own measurements: what left the treasury and
 * what arrived at the owner. A swap that lied about either reverted, and a
 * reverted transaction emits nothing, so every row here is a trade that passed
 * the postconditions.
 *
 * The venue and instrument rows are created if missing. A swap cannot happen
 * without both being allowed, but this subgraph may start after that approval.
 */
export function handleSwapExecuted(event: SwapExecuted): void {
  const agent = loadOrCreateAgent(event.params.agentId, event.block.timestamp, event.block.number);
  agent.swapCount = agent.swapCount.plus(BigInt.fromI32(1));
  agent.save();

  const venueId = agent.id.concat(event.params.venue);
  let venue = Venue.load(venueId);
  if (venue == null) {
    venue = new Venue(venueId);
    venue.agent = agent.id;
    venue.venue = event.params.venue;
    venue.allowed = true;
    venue.changeCount = BigInt.zero();
    venue.firstAllowedAt = event.block.timestamp;
    venue.updatedAt = event.block.timestamp;
    venue.updatedBlock = event.block.number;
    venue.save();
  }

  const instrumentId = agent.id.concat(event.params.tokenOut);
  let instrument = Instrument.load(instrumentId);
  if (instrument == null) {
    instrument = new Instrument(instrumentId);
    instrument.agent = agent.id;
    instrument.token = event.params.tokenOut;
    instrument.allowed = true;
    instrument.changeCount = BigInt.zero();
    instrument.firstAllowedAt = event.block.timestamp;
    instrument.updatedAt = event.block.timestamp;
    instrument.updatedBlock = event.block.number;
    instrument.save();
  }

  const swap = new Swap(
    event.transaction.hash.concatI32(event.logIndex.toI32()),
  );
  swap.agent = agent.id;
  swap.venue = venueId;
  swap.instrument = instrumentId;
  swap.amountIn = event.params.amountIn;
  swap.amountOut = event.params.amountOut;
  swap.blockNumber = event.block.number;
  swap.timestamp = event.block.timestamp;
  swap.transactionHash = event.transaction.hash;
  swap.save();
}

function treasuryMove(
  agentId: BigInt,
  direction: string,
  counterparty: Bytes,
  amount: BigInt,
  timestamp: BigInt,
  block: BigInt,
  txHash: Bytes,
  logIndex: i32,
): void {
  const agent = loadOrCreateAgent(agentId, timestamp, block);
  agent.treasury = direction == "in" ? agent.treasury.plus(amount) : agent.treasury.minus(amount);
  agent.save();

  const move = new TreasuryMove(txHash.concatI32(logIndex));
  move.agent = agent.id;
  move.direction = direction;
  move.counterparty = counterparty;
  move.amount = amount;
  move.blockNumber = block;
  move.timestamp = timestamp;
  move.transactionHash = txHash;
  move.save();
}

export function handleDeposited(event: Deposited): void {
  treasuryMove(
    event.params.agentId, "in", event.params.from, event.params.amount,
    event.block.timestamp, event.block.number, event.transaction.hash, event.logIndex.toI32(),
  );
}

export function handleWithdrawn(event: Withdrawn): void {
  treasuryMove(
    event.params.agentId, "out", event.params.to, event.params.amount,
    event.block.timestamp, event.block.number, event.transaction.hash, event.logIndex.toI32(),
  );
}
