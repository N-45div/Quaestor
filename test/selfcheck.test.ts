import { expect } from "chai";
import { ethers } from "ethers";
import { assessSpend } from "../agent/selfcheck";
import type { AgentBudget, BudgetSource, SpendShape } from "../services/graph";

const GOVERNOR = "0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24";
const OTHER = "0x7C8772fbdF1A1d9D2E9F3f1c8B0a5e4D3C2B1A098";

function shape(over: Partial<SpendShape> = {}): SpendShape {
  return {
    epochsSeen: 3,
    receiptCountThisEpoch: 1,
    maxReceiptThisEpoch: 0n,
    maxPriorReceipt: ethers.parseEther("0.01"),
    maxPriorReceiptCount: 4,
    maxPriorEpochSpend: ethers.parseEther("0.03"),
    firstAtThisEpoch: 1,
    lastAtThisEpoch: 2,
    truncated: false,
    ...over,
  };
}

function source(opts: {
  governor?: string;
  shape?: SpendShape | null;
  throws?: string;
}): BudgetSource {
  return {
    name: "fake",
    governor: opts.governor ?? GOVERNOR,
    async budget(): Promise<AgentBudget> {
      if (opts.throws) throw new Error(opts.throws);
      return {
        agentId: "1",
        category: 2,
        categoryName: "EXECUTION",
        registeredAt: 0,
        epochLength: 3600,
        suspended: false,
        epochCap: ethers.parseEther("1"),
        perCallCap: ethers.parseEther("1"),
        currentEpoch: "3",
        spentThisEpoch: 0n,
        remaining: ethers.parseEther("1"),
        source: "subgraph",
        head: null,
        shape: opts.shape === undefined ? shape() : opts.shape,
      };
    },
    async receipts() {
      return [];
    },
  };
}

const call = (budgets: BudgetSource | null, amount: string, governor = GOVERNOR) =>
  assessSpend({
    budgets,
    governor,
    agentId: 1,
    category: 2,
    amountWei: ethers.parseEther(amount),
    burstMultiple: 3,
  });

describe("agent self-check", () => {
  it("stands down when a spend is more than 3x the largest it has ever made", async () => {
    // Largest ever is 0.01, so the ceiling is 0.03.
    const bad = await call(source({}), "0.04");
    expect(bad.ok).to.equal(false);
    expect(bad.checked).to.equal(true);
    expect(bad.reason).to.contain("more than 3×");
  });

  it("allows a spend exactly at the ceiling, and the one below it", async () => {
    expect((await call(source({}), "0.03")).ok).to.equal(true);
    expect((await call(source({}), "0.0299")).ok).to.equal(true);
  });

  it("refuses to consult a source that indexes a different governor", async () => {
    // Agent #1 exists on every chain the contract is deployed to. Reading the
    // wrong one is a confident wrong answer, so a huge spend must NOT be
    // judged against a foreign history — it passes unchecked instead.
    const res = await call(source({ governor: OTHER }), "999");
    expect(res.ok).to.equal(true);
    expect(res.checked).to.equal(false);
    expect(res.reason).to.contain("different governor");
  });

  it("proceeds, unchecked, when the index is stale — the caps still hold", async () => {
    const res = await call(source({ throws: "subgraph is 900s behind" }), "999");
    expect(res.ok).to.equal(true);
    expect(res.checked).to.equal(false);
    expect(res.reason).to.contain("history unavailable");
  });

  it("proceeds when the source cannot see shape at all", async () => {
    const res = await call(source({ shape: null }), "999");
    expect(res.ok).to.equal(true);
    expect(res.checked).to.equal(false);
    expect(res.reason).to.contain("cannot see spend shape");
  });

  it("distinguishes no-history from could-not-check", async () => {
    // A brand-new agent has nothing to break. The rule RAN and found nothing,
    // which is a different statement from being unable to run.
    const fresh = await call(source({ shape: shape({ maxPriorReceipt: 0n }) }), "999");
    expect(fresh.ok).to.equal(true);
    expect(fresh.checked).to.equal(true);
    expect(fresh.reason).to.contain("nothing to compare");
  });

  it("proceeds when there is no budget source configured", async () => {
    const res = await call(null, "999");
    expect(res.ok).to.equal(true);
    expect(res.checked).to.equal(false);
  });
});
