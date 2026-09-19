import { expect } from "chai";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DevnetQuoteProvider,
  SolanaStockExecutor,
  type JupiterQuote,
  type SolanaRouteBuilder,
  type StockTradeIntent,
} from "../stocks";

const MINT = "AAbNhnZQhWxU6mN3yBzJJ4NqJ4vPTh8VYs7v6a1pFAKE";
const USDC = "8HcqMLfakeusdcmint1111111111111111111111111";

describe("Solana execution", () => {
  describe("devnet quotes", () => {
    const provider = (price: number | undefined, slippageBps = 50) =>
      new DevnetQuoteProvider({
        venue: "router-stub",
        instrumentDecimals: 8,
        slippageBps,
        priceUsd: async () => price,
        now: () => 1_789_720_000,
      });

    it("prices the instrument from the live reference", async () => {
      const q = await provider(336).quote(USDC, MINT, 5_000_000n);
      // 5 USDC at $336 is 0.01488… of a share, in eight decimals.
      expect(q.outAmount).to.equal(1_488_095n);
      expect(q.venue).to.equal("router-stub");
      expect(q.route).to.contain("$336.00");
    });

    it("puts the guaranteed floor below the expected fill by the slippage", async () => {
      const q = await provider(336, 50).quote(USDC, MINT, 5_000_000n);
      expect(q.minimumOutput).to.equal((q.outAmount * 9_950n) / 10_000n);
      expect(q.minimumOutput! < q.outAmount).to.equal(true);
    });

    it("refuses to quote without a live price rather than guessing one", async () => {
      await expect(provider(undefined).quote(USDC, MINT, 5_000_000n)).to.be.rejectedWith("no live price");
      await expect(provider(0).quote(USDC, MINT, 5_000_000n)).to.be.rejectedWith("no live price");
    });

    it("refuses an amount too small to buy a single unit", async () => {
      await expect(provider(336).quote(USDC, MINT, 0n)).to.be.rejectedWith("must be positive");
    });
  });

  describe("executor outcomes", () => {
    const operator = Keypair.generate();
    const payer = Keypair.generate();
    const owner = Keypair.generate().publicKey;
    const blockhash = Keypair.generate().publicKey.toBase58();

    const intent: StockTradeIntent = {
      intentId: "intent-1",
      agentId: "agent-1",
      operator: operator.publicKey.toBase58(),
      instrumentMint: MINT,
      inputMint: USDC,
      amountInUsdc: 5_000_000n,
      minOutput: 1_400_000n,
      quoteId: "q1",
      quoteExpiresAt: 0,
      intentExpiresAt: 0,
      decisionRecordHash: `0x${"11".repeat(32)}`,
      decisionHash: `0x${"22".repeat(32)}`,
    };
    const quote = { quoteId: "q1", venue: "router-stub", inputMint: USDC, outputMint: MINT, inAmount: 5_000_000n, outAmount: 1_486_679n, minimumOutput: 1_400_000n, route: "stub", expiresAt: 0 } as JupiterQuote;

    const route: SolanaRouteBuilder = {
      venue: "router-stub",
      build: async () => ({
        programId: Keypair.generate().publicKey,
        accounts: [],
        data: Buffer.from([1, 2, 3]),
      }),
    };

    /** An IntentRecord as the program lays it out; actualOutput sits at byte 160. */
    const intentRecord = (actualOutput: bigint) => {
      const data = Buffer.alloc(185);
      data.writeBigUInt64LE(actualOutput, 160);
      return { data, executable: false, lamports: 1, owner: PublicKey.default, rentEpoch: 0 };
    };

    /** A transaction's id is its first signature, in base58 — known before it is sent. */
    const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

    const executor = (connection: unknown) => new SolanaStockExecutor({
      // Short, so a test of "the chain never answered" does not take a minute.
      resolveTimeoutMs: 60,
      resolvePollMs: 5,
      connection: connection as Connection,
      governorOwner: owner,
      vault: Keypair.generate().publicKey,
      operator,
      payer,
      cluster: "devnet",
      instruments: new Map([[MINT, { stockAccount: Keypair.generate().publicKey }]]),
      routes: new Map([["router-stub", route]]),
    });

    it("reports what the chain measured, not what the quote expected", async () => {
      const filled = 1_486_679n;
      let confirmed = "";
      const result = await executor({
        getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1 }),
        sendRawTransaction: async () => "whatever-the-rpc-says",
        confirmTransaction: async ({ signature }: { signature: string }) => {
          confirmed = signature;
          return { value: { err: null } };
        },
        getAccountInfo: async () => intentRecord(filled),
      }).execute(intent, { ...quote, outAmount: 9_999_999n });
      expect(result.outcome).to.equal("settled");
      // The signature is the transaction's own, not whatever an RPC node chose
      // to echo back, and it is the one confirmation was awaited on.
      expect(result.txSignature).to.match(SIGNATURE);
      expect(result.txSignature).to.equal(confirmed);
      // The quote said 9,999,999; the record said what actually arrived.
      expect(result.actualOutput).to.equal(filled);
    });

    it("returns a confirmed revert as not-executed, with its signature", async () => {
      const result = await executor({
        getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1 }),
        sendRawTransaction: async () => "ignored",
        confirmTransaction: async () => ({ value: { err: { InstructionError: [0, { Custom: 6017 }] } } }),
        getTransaction: async () => ({ meta: { logMessages: ["Error Code: MinimumOutputNotMet."] } }),
      }).execute(intent, quote);
      // A refusal is an outcome an agent can read, not an exception.
      expect(result.outcome).to.equal("not-executed");
      expect(result.txSignature).to.match(SIGNATURE);
      expect(result.actualOutput).to.equal(0n);
    });

    it("throws only when the chain cannot be asked at all, so the intent stays pending", async () => {
      // "We could not find out" must never be reported as "it did not happen":
      // a retry on that basis is how a trade happens twice.
      const unreachable = async () => { throw new Error("socket hang up"); };
      await expect(executor({
        getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1 }),
        sendRawTransaction: unreachable,
        getAccountInfo: unreachable,
        getSignatureStatuses: unreachable,
        getEpochInfo: unreachable,
      }).execute(intent, quote)).to.be.rejectedWith("outcome is not yet known");
    });

    it("settles a submission that went quiet but landed", async () => {
      // The send call died; the trade did not. The program writes the intent's
      // record in the same transaction as the trade, so the record is the proof.
      let asked = 0;
      const result = await executor({
        getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
        sendRawTransaction: async () => { throw new Error("socket hang up"); },
        getAccountInfo: async () => (++asked < 3 ? null : intentRecord(1_486_679n)),
        getSignatureStatuses: async () => ({ context: { slot: 900 }, value: [null] }),
        getEpochInfo: async () => ({ blockHeight: 50, absoluteSlot: 900 }),
      }).execute(intent, quote);
      expect(result.outcome).to.equal("settled");
      expect(result.actualOutput).to.equal(1_486_679n);
      expect(result.txSignature).to.match(SIGNATURE);
    });

    it("releases a submission that went quiet and can no longer land", async () => {
      // Past its last valid block with no record and no status, the transaction
      // is not late — it is impossible. Leaving it pending would hold its
      // reservation against the daily cap for everyone, for good.
      const result = await executor({
        getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
        sendRawTransaction: async () => { throw new Error("socket hang up"); },
        getAccountInfo: async () => null,
        getSignatureStatuses: async () => ({ context: { slot: 1_000 }, value: [null] }),
        getEpochInfo: async () => ({ blockHeight: 101, absoluteSlot: 1_000 }),
      }).execute(intent, quote);
      expect(result.outcome).to.equal("not-executed");
      expect(result.actualOutput).to.equal(0n);
    });

    it("does not take a lagging node's silence for proof that it never landed", async () => {
      // Behind a pooled RPC, one node says the blockhash has expired while
      // another, still behind, says it has never heard of the transaction. That
      // is two nodes disagreeing, not a transaction that failed — and calling it
      // failed would release the reservation of a trade that may have landed.
      await expect(executor({
        getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
        sendRawTransaction: async () => { throw new Error("socket hang up"); },
        getAccountInfo: async () => null,
        getSignatureStatuses: async () => ({ context: { slot: 940 }, value: [null] }),
        getEpochInfo: async () => ({ blockHeight: 101, absoluteSlot: 1_000 }),
      }).execute(intent, quote)).to.be.rejectedWith("outcome is not yet known");
    });

    it("does not believe a failure the cluster has not voted on", async () => {
      // An error seen at `processed` may belong to a fork that loses, while the
      // same signature succeeds on the fork that wins.
      await expect(executor({
        getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
        sendRawTransaction: async () => { throw new Error("socket hang up"); },
        getAccountInfo: async () => null,
        getSignatureStatuses: async () => ({ context: { slot: 900 }, value: [{ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "processed" }] }),
        getEpochInfo: async () => ({ blockHeight: 50, absoluteSlot: 900 }),
      }).execute(intent, quote)).to.be.rejectedWith("outcome is not yet known");
    });

    it("never turns a confirmed trade into a pending one because the record could not be read", async () => {
      // The send confirmed. If reading the record then fails for the whole
      // window, the trade still happened: it is reported settled at the floor
      // the program enforces — a true lower bound — rather than left holding
      // its reservation against everyone's daily cap.
      const result = await executor({
        getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1 }),
        sendRawTransaction: async () => "ignored",
        confirmTransaction: async () => ({ value: { err: null } }),
        getAccountInfo: async () => { throw new Error("rpc 503"); },
        getSignatureStatuses: async () => { throw new Error("rpc 503"); },
        getEpochInfo: async () => { throw new Error("rpc 503"); },
      }).execute(intent, quote);
      expect(result.outcome).to.equal("settled");
      expect(result.actualOutput).to.equal(intent.minOutput);
    });

    it("still reports a confirmed revert when its logs cannot be fetched", async () => {
      const result = await executor({
        getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1 }),
        sendRawTransaction: async () => "ignored",
        confirmTransaction: async () => ({ value: { err: { InstructionError: [0, { Custom: 6017 }] } } }),
        getTransaction: async () => { throw new Error("rpc 503"); },
      }).execute(intent, quote);
      expect(result.outcome).to.equal("not-executed");
      expect(result.txSignature).to.match(SIGNATURE);
    });

    it("does not call a quiet submission failed while it could still land", async () => {
      // No record and no status, but the blockhash is still valid: unknown.
      await expect(executor({
        getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
        sendRawTransaction: async () => { throw new Error("socket hang up"); },
        getAccountInfo: async () => null,
        getSignatureStatuses: async () => ({ context: { slot: 900 }, value: [null] }),
        getEpochInfo: async () => ({ blockHeight: 60, absoluteSlot: 900 }),
      }).execute(intent, quote)).to.be.rejectedWith("outcome is not yet known");
    });

    it("releases a trade that was never submitted", async () => {
      // Nothing left the process, so nothing can have happened.
      const result = await executor({
        getLatestBlockhash: async () => { throw new Error("rpc down"); },
      }).execute(intent, quote);
      expect(result).to.include({ outcome: "not-executed", txSignature: "not-submitted" });
    });

    // By the time the executor runs the governor has reserved the amount, so a
    // misconfiguration must come back as "nothing happened" — which releases the
    // reservation — rather than as a throw, which strands it.
    it("releases a trade through a venue it has no route builder for", async () => {
      const result = await executor({}).execute(intent, { ...quote, venue: "jupiter" });
      expect(result).to.include({ outcome: "not-executed", txSignature: "not-submitted" });
    });

    it("releases a trade in an instrument with no position account", async () => {
      const result = await executor({}).execute({ ...intent, instrumentMint: "other" }, quote);
      expect(result).to.include({ outcome: "not-executed", txSignature: "not-submitted" });
    });
  });
});
