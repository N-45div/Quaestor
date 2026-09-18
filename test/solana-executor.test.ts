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

    const executor = (connection: unknown) => new SolanaStockExecutor({
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
      const result = await executor({
        getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1 }),
        sendRawTransaction: async () => "SIG_OK",
        confirmTransaction: async () => ({ value: { err: null } }),
        getAccountInfo: async () => intentRecord(filled),
      }).execute(intent, { ...quote, outAmount: 9_999_999n });
      expect(result.outcome).to.equal("settled");
      expect(result.txSignature).to.equal("SIG_OK");
      // The quote said 9,999,999; the record said what actually arrived.
      expect(result.actualOutput).to.equal(filled);
    });

    it("returns a confirmed revert as not-executed, with its signature", async () => {
      const result = await executor({
        getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1 }),
        sendRawTransaction: async () => "SIG_REVERTED",
        confirmTransaction: async () => ({ value: { err: { InstructionError: [0, { Custom: 6017 }] } } }),
        getTransaction: async () => ({ meta: { logMessages: ["Error Code: MinimumOutputNotMet."] } }),
      }).execute(intent, quote);
      // A refusal is an outcome an agent can read, not an exception.
      expect(result).to.include({ outcome: "not-executed", txSignature: "SIG_REVERTED" });
      expect(result.actualOutput).to.equal(0n);
    });

    it("throws when the network never answered, so the intent stays pending", async () => {
      // A submission that timed out may still land; reporting it as
      // not-executed would invite a retry that trades twice.
      await expect(executor({
        getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1 }),
        sendRawTransaction: async () => { throw new Error("socket hang up"); },
      }).execute(intent, quote)).to.be.rejectedWith("socket hang up");
    });

    it("refuses a venue it has no route builder for", async () => {
      await expect(executor({}).execute(intent, { ...quote, venue: "jupiter" }))
        .to.be.rejectedWith('no route builder configured for venue "jupiter"');
    });

    it("refuses an instrument with no position account", async () => {
      await expect(executor({}).execute({ ...intent, instrumentMint: "other" }, quote))
        .to.be.rejectedWith("no position account configured");
    });
  });
});
