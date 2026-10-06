import { expect } from "chai";
import { ethers } from "ethers";
import { GOVERNOR_ABI, MONAD_TESTNET } from "../sdk/evm-stocks";
import { Tape, TRADE_TOPIC, type MonadLog } from "../services/monad-tape";

/**
 * The live tape fed by Alchemy's monadLogs: a governed fill shows at proposal and is advanced as
 * its block is voted and finalized, a log from a contract the factory never made is ignored, and
 * a proposal that is dropped from the chain leaves the tape.
 */
describe("monad live tape", () => {
  const iface = new ethers.Interface(GOVERNOR_ABI);
  const governor = "0xD64E22Ff0D0dc311d89Bcc5C5113F9e7f149157C";
  const tSPY = MONAD_TESTNET.instruments.find((i) => i.symbol === "tSPY")!;

  function log(commitState: string, address = governor, removed = false): MonadLog {
    const e = iface.encodeEventLog("TradeExecuted", [ethers.id("intent"), MONAD_TESTNET.venues[0].router, tSPY.address, 2_000_000n, 2_591_109_000_000_000n, ethers.id("why"), 1n, 2_000_000n]);
    return { address, topics: e.topics, data: e.data, transactionHash: "0xf2ec354de9c645a09286b51e2e2ce9159d9b7f9d26e98158d7819daea2110ab3", logIndex: "0x3", blockNumber: "0x41799b1", commitState, removed };
  }

  it("shows a governed fill at proposal and advances it to final", async () => {
    let t = 1_000;
    const tape = new Tape(MONAD_TESTNET, async (a) => a === governor, () => t);
    expect(TRADE_TOPIC).to.equal(log("Proposed").topics[0]);
    const proposed = await tape.accept(log("Proposed"));
    expect(proposed).to.include({ stage: "Proposed", stock: "tSPY", spent: "2.0", proposedAt: 1_000 });
    expect(Number(proposed!.pricePerShare)).to.be.closeTo(771.87, 0.01);
    t = 1_400;
    await tape.accept(log("Voted"));
    t = 1_900;
    await tape.accept(log("Finalized"));
    expect(tape.recent()).to.have.length(1);
    expect(tape.recent()[0]).to.include({ stage: "Finalized", proposedAt: 1_000, votedAt: 1_400, finalizedAt: 1_900 });
  });

  it("ignores the same event from a contract the factory never made, and drops a removed proposal", async () => {
    const tape = new Tape(MONAD_TESTNET, async (a) => a === governor);
    expect(await tape.accept(log("Proposed", "0x000000000000000000000000000000000000dEaD"))).to.equal(null);
    await tape.accept(log("Proposed"));
    expect(tape.recent()).to.have.length(1);
    await tape.accept(log("Proposed", governor, true));
    expect(tape.recent()).to.have.length(0);
  });
});
