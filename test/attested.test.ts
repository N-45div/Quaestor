import { expect } from "chai";
import { ethers, network } from "hardhat";
import type { ContractTransactionReceipt, TransactionResponse } from "ethers";
import type { MockNativeQueryVerifier, Quaestor, QuaestorAttested } from "../typechain-types";

/**
 * QuaestorAttested — the cross-chain budget root, tested against real bytes.
 *
 * The Attestcoin BlockProver precompile lives at a constant address, so we
 * install a mock at that address with hardhat_setCode. The transaction bytes
 * are NOT a fixture: every case performs a real governor spend on the local
 * chain and encodes that transaction + receipt into the prover's EvmV1 format
 * (`abi.encode(uint8 txType, bytes[] chunks)`), so the decoder path runs on
 * genuine data.
 */

const PRECOMPILE = "0x0000000000000000000000000000000000000FD2";
const CHAIN_KEY = 1; // Ethereum Sepolia's chain key on Creditcoin testnet
const DATA = 0;
const coder = ethers.AbiCoder.defaultAbiCoder();

async function encodeEvmV1(tx: TransactionResponse, rc: ContractTransactionReceipt): Promise<string> {
  const chunk0 = coder.encode(
    ["uint64", "uint64", "address", "bool", "address", "uint256", "bytes"],
    [tx.nonce, tx.gasLimit, tx.from, tx.to == null, tx.to ?? ethers.ZeroAddress, tx.value, tx.data]
  );
  // Type-2 specific fields; the decoder does not read them for receipt work,
  // but the chunk must exist so the chunk count is right.
  const chunk1 = coder.encode(
    ["uint64", "uint128", "uint128", "tuple(address,bytes32[])[]", "uint8", "bytes32", "bytes32"],
    [tx.chainId, tx.maxPriorityFeePerGas ?? 0n, tx.maxFeePerGas ?? 0n, [], 0, ethers.ZeroHash, ethers.ZeroHash]
  );
  const logs = rc.logs.map((l) => [l.address, [...l.topics], l.data]);
  const chunk2 = coder.encode(
    ["uint8", "uint64", "tuple(address,bytes32[],bytes)[]", "bytes"],
    [rc.status ?? 1, rc.gasUsed, logs, rc.logsBloom]
  );
  return coder.encode(["uint8", "bytes[]"], [2, [chunk0, chunk1, chunk2]]);
}

/** A distinct Merkle path per transaction so query ids differ. */
function path(index: number, depth = 4) {
  const siblings = [];
  for (let i = 0; i < depth; i++) siblings.push({ hash: ethers.keccak256(ethers.toUtf8Bytes(`s${index}-${i}`)), isLeft: ((index >> i) & 1) === 1 });
  return { root: ethers.keccak256(ethers.toUtf8Bytes(`root-${index}`)), siblings };
}

describe("QuaestorAttested — cross-chain budget root", () => {
  let owner: any, operator: any, guardian: any, payee: any, stranger: any;
  let quaestor: Quaestor, attested: QuaestorAttested, mock: MockNativeQueryVerifier;
  let agentId: bigint;
  let nextIndex = 1;

  const spend = async (amountEth: string, gov: Quaestor = quaestor, id: bigint = agentId) => {
    const meta = ethers.keccak256(ethers.toUtf8Bytes(`decision-${nextIndex}`));
    const tx = (await gov
      .connect(operator)
      .pay(id, DATA, payee.address, ethers.parseEther(amountEth), meta)) as TransactionResponse;
    const rc = (await tx.wait()) as ContractTransactionReceipt;
    return { bytes: await encodeEvmV1(tx, rc), height: rc.blockNumber, proof: path(nextIndex++), meta };
  };

  const execute = (action: number, s: { bytes: string; height: number; proof: ReturnType<typeof path> }) =>
    attested.execute(action, CHAIN_KEY, s.height, s.bytes, s.proof.root, s.proof.siblings, ethers.ZeroHash, [s.proof.root]);

  before(async () => {
    [owner, operator, guardian, payee, stranger] = await ethers.getSigners();

    // The precompile: install the mock's runtime code at the constant address.
    const MockF = await ethers.getContractFactory("MockNativeQueryVerifier");
    const deployedMock = await MockF.deploy();
    await deployedMock.waitForDeployment();
    const code = await ethers.provider.getCode(await deployedMock.getAddress());
    await network.provider.send("hardhat_setCode", [PRECOMPILE, code]);
    mock = MockF.attach(PRECOMPILE) as unknown as MockNativeQueryVerifier;

    // A governor on the "source chain" (locally, the same chain).
    const dex = await ethers.deployContract("QuaestorDEX");
    quaestor = await ethers.deployContract("Quaestor", [await dex.getAddress()]);
    const big = { epochCap: ethers.parseEther("10"), perCallCap: ethers.parseEther("1") };
    const rtx = await quaestor.registerAgent(operator.address, 3600, '{"name":"Cato"}', big, big, big, {
      value: ethers.parseEther("5"),
    });
    await rtx.wait();
    agentId = 1n;
    await (await quaestor.setGuardian(agentId, guardian.address)).wait();

    // The budget root.
    attested = await ethers.deployContract("QuaestorAttested");
    await (await attested.registerSource(CHAIN_KEY, await quaestor.getAddress())).wait();
    await (await attested.linkAgent(7, await quaestor.getAddress(), agentId)).wait();
    await (await attested.setGlobalCap(7, ethers.parseEther("0.05"), 3600)).wait();
  });

  it("credits an attested Receipt to the group's global tally", async () => {
    const s = await spend("0.02");
    await expect(execute(0, s))
      .to.emit(attested, "SpendAttested")
      .withArgs(7, await quaestor.getAddress(), agentId, DATA, ethers.parseEther("0.02"), s.meta, (q: string) => q.length === 66, ethers.parseEther("0.02"));
    expect(await attested.globalSpent(7)).to.equal(ethers.parseEther("0.02"));
    expect(await attested.globalRemaining(7)).to.equal(ethers.parseEther("0.03"));
    expect(await attested.isBreached(7)).to.equal(false);
  });

  it("refuses to process the same proof twice", async () => {
    const s = await spend("0.001");
    await (await execute(0, s)).wait();
    await expect(execute(0, s)).to.be.revertedWith("Query already processed");
  });

  it("marks the group breached when the cross-chain sum exceeds the global cap, and only the owner clears it", async () => {
    const s = await spend("0.04"); // 0.02 + 0.001 + 0.04 > 0.05
    await expect(execute(0, s)).to.emit(attested, "GlobalCapBreached");
    expect(await attested.isBreached(7)).to.equal(true);
    await expect(attested.connect(stranger).clearBreach(7)).to.be.revertedWithCustomError(attested, "NotOwner");
    await expect(attested.clearBreach(7)).to.emit(attested, "BreachCleared").withArgs(7, owner.address);
    expect(await attested.isBreached(7)).to.equal(false);
  });

  it("rejects a Receipt from a governor nobody registered", async () => {
    const dex = await ethers.deployContract("QuaestorDEX");
    const impostor = await ethers.deployContract("Quaestor", [await dex.getAddress()]);
    const big = { epochCap: ethers.parseEther("10"), perCallCap: ethers.parseEther("1") };
    await (
      await impostor.registerAgent(operator.address, 3600, '{"name":"fake"}', big, big, big, { value: ethers.parseEther("1") })
    ).wait();
    const s = await spend("0.01", impostor, 1n);
    await expect(execute(0, s)).to.be.revertedWithCustomError(attested, "UnregisteredGovernor");
  });

  it("rejects a linked-but-unknown agent on a registered governor", async () => {
    const big = { epochCap: ethers.parseEther("10"), perCallCap: ethers.parseEther("1") };
    await (
      await quaestor.registerAgent(operator.address, 3600, '{"name":"other"}', big, big, big, { value: ethers.parseEther("1") })
    ).wait();
    const s = await spend("0.01", quaestor, 2n);
    await expect(execute(0, s)).to.be.revertedWithCustomError(attested, "AgentNotLinked");
  });

  it("attests a suspension into the threat feed", async () => {
    const tx = (await quaestor.connect(guardian).suspend(agentId)) as TransactionResponse;
    const rc = (await tx.wait()) as ContractTransactionReceipt;
    const s = { bytes: await encodeEvmV1(tx, rc), height: rc.blockNumber, proof: path(nextIndex++) };
    await expect(execute(1, s))
      .to.emit(attested, "SuspensionAttested")
      .withArgs(await quaestor.getAddress(), agentId, guardian.address, (q: string) => q.length === 66, 1);
    await (await quaestor.resume(agentId)).wait();
  });

  it("refuses when the wrong action is claimed for the logs in the transaction", async () => {
    const s = await spend("0.001");
    await expect(execute(1, s)).to.be.revertedWithCustomError(attested, "NoMatchingLogs");
  });

  it("verifies a batch under one continuity proof and credits every receipt", async () => {
    const before = await attested.globalSpent(7);
    const a = await spend("0.002");
    const b = await spend("0.003");
    await expect(
      attested.executeBatch(0, {
        chainKey: CHAIN_KEY,
        heights: [a.height, b.height],
        encodedTransactions: [a.bytes, b.bytes],
        merkleRoots: [a.proof.root, b.proof.root],
        siblings: [a.proof.siblings, b.proof.siblings],
        lowerEndpointDigest: ethers.ZeroHash,
        continuityRoots: [a.proof.root, b.proof.root],
      })
    ).to.emit(attested, "SpendAttested");
    expect((await attested.globalSpent(7)) - before).to.equal(ethers.parseEther("0.005"));
    // and neither can be replayed singly
    await expect(execute(0, a)).to.be.revertedWith("Query already processed");
  });

  it("fails closed when the precompile does not verify", async () => {
    await (await mock.setReject(true)).wait();
    const s = await spend("0.001");
    await expect(execute(0, s)).to.be.revertedWith("Proof of inclusion verification failed");
    await (await mock.setReject(false)).wait();
  });
});
