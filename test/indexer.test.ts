import { expect } from "chai";
import { mergeReceiptRange, type IndexedReceipt } from "../services/indexer";

const row = (blockNumber: number, txHash: string, logIndex = 0): IndexedReceipt => ({
  txHash,
  logIndex,
  chainId: 1952,
  governor: "0x0000000000000000000000000000000000000001",
  blockNumber,
  timestamp: blockNumber * 1000,
  agentId: "1",
  category: 0,
  payee: "0x0000000000000000000000000000000000000002",
  amount: "1",
  metaHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
  epoch: "0",
  epochSpentAfter: "1",
});

describe("chain-scoped receipt history", () => {
  it("replaces a rescanned range and keeps deterministic order", () => {
    const previous = [row(10, "0xa"), row(11, "0xb"), row(12, "0xc")];
    const fresh = [row(11, "0xd", 1), row(11, "0xe", 0)];
    const result = mergeReceiptRange(previous, fresh, 11, 11);
    expect(result.map((r) => `${r.blockNumber}:${r.logIndex}:${r.txHash}`)).to.deep.equal([
      "10:0:0xa",
      "11:0:0xe",
      "11:1:0xd",
      "12:0:0xc",
    ]);
  });

  it("deduplicates one event without crossing chain identities", () => {
    const same = row(10, "0xa");
    const other = { ...same, chainId: 84532 };
    expect(mergeReceiptRange([same, same, other], [], 99, 100)).to.have.length(2);
  });
});
