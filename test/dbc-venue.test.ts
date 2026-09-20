import { expect } from "chai";
import { Keypair, PublicKey, type AccountMeta } from "@solana/web3.js";
import {
  DBC_VENUE,
  DbcPoolPriceSource,
  DbcQuoteProvider,
  DbcRouteBuilder,
  type DbcPool,
  type DbcSwapAccounts,
} from "../stocks/dbc-venue";
import { NoRouteError } from "../stocks/venues";
import type { JupiterQuote, StockInstrument, StockTradeIntent } from "../stocks/types";

const key = () => Keypair.generate().publicKey;
const USDC = key().toBase58();
const CURVE_TOKEN = key().toBase58();

/** A curve that can be moved, graduated or asked for the wrong signatures. */
class FakePool implements DbcPool {
  readonly baseMint = CURVE_TOKEN;
  readonly quoteMint = USDC;
  readonly programId = key();
  priceUsd = 324.5;
  progress = 0.0005;
  graduated = false;
  extraSigner: PublicKey | null = null;
  built: Array<{ accounts: DbcSwapAccounts; amountIn: bigint; minimumOut: bigint }> = [];

  async quoteBuy(amountIn: bigint, slippageBps: number) {
    if (this.graduated) throw new NoRouteError("this curve has graduated to a DAMM v2 pool and no longer fills");
    const outAmount = BigInt(Math.floor((Number(amountIn) / this.priceUsd) * 0.99));
    return { outAmount, minimumOutput: (outAmount * BigInt(10_000 - slippageBps)) / 10_000n, priceUsd: this.priceUsd, progress: this.progress };
  }

  async spot() {
    return this.graduated ? undefined : { priceUsd: this.priceUsd, progress: this.progress };
  }

  async swapInstruction(accounts: DbcSwapAccounts, amountIn: bigint, minimumOut: bigint) {
    this.built.push({ accounts, amountIn, minimumOut });
    const keys: AccountMeta[] = [
      { pubkey: key(), isSigner: false, isWritable: false },
      { pubkey: accounts.inputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.outputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.payer, isSigner: true, isWritable: false },
      ...(this.extraSigner ? [{ pubkey: this.extraSigner, isSigner: true, isWritable: false }] : []),
    ];
    return { keys, data: Buffer.from([1, 2, 3]) };
  }
}

const instrument = (mint: string): StockInstrument => ({ symbol: "T", issuer: "test", mint, usdcMint: USDC, decimals: 6, enabled: true });

describe("Meteora DBC as a governed venue", () => {
  describe("quotes", () => {
    it("quotes the curve's own floor, names the venue, and says how far the curve has to run", async () => {
      const pool = new FakePool();
      const quotes = new DbcQuoteProvider({ pool, slippageBps: 50, quoteTtlSeconds: 90, now: () => 1_000 });
      const quote = await quotes.quote(USDC, CURVE_TOKEN, 2_000_000n);
      expect(quote.venue).to.equal(DBC_VENUE);
      expect(quote.inAmount).to.equal(2_000_000n);
      expect(quote.minimumOutput).to.equal((quote.outAmount * 9_950n) / 10_000n);
      expect(quote.minimumOutput! < quote.outAmount).to.equal(true);
      expect(quote.expiresAt).to.equal(1_090);
      expect(quote.route).to.contain("$324.5000").and.to.contain("0.05% to graduation");
    });

    it("answers no route, not an outage, for any pair but its own", async () => {
      const quotes = new DbcQuoteProvider({ pool: new FakePool() });
      const other = key().toBase58();
      for (const [input, output] of [[USDC, other], [other, CURVE_TOKEN], [CURVE_TOKEN, USDC]]) {
        let thrown: unknown;
        try { await quotes.quote(input, output, 2_000_000n); } catch (error) { thrown = error; }
        expect(thrown).to.be.instanceOf(NoRouteError);
      }
    });

    it("stops quoting the moment the curve has graduated", async () => {
      const pool = new FakePool();
      const quotes = new DbcQuoteProvider({ pool });
      await quotes.quote(USDC, CURVE_TOKEN, 2_000_000n);
      pool.graduated = true;
      let thrown: unknown;
      try { await quotes.quote(USDC, CURVE_TOKEN, 2_000_000n); } catch (error) { thrown = error; }
      expect(thrown).to.be.instanceOf(NoRouteError);
      expect((thrown as Error).message).to.contain("graduated");
    });

    it("will not quote a buy too small to guarantee anything", async () => {
      const quotes = new DbcQuoteProvider({ pool: new FakePool() });
      let thrown: unknown;
      try { await quotes.quote(USDC, CURVE_TOKEN, 100n); } catch (error) { thrown = error; }
      expect(thrown).to.be.instanceOf(NoRouteError);
    });
  });

  describe("route", () => {
    const vaultAuthority = key();
    const vault = key();
    const stockAccount = key();
    const intent = { instrumentMint: CURVE_TOKEN } as StockTradeIntent;
    const quote = {} as JupiterQuote;

    it("pays from the vault into the position, as the vault's PDA, at the intent's floor", async () => {
      const pool = new FakePool();
      const route = await new DbcRouteBuilder({ pool, vaultAuthority, vault, stockAccount })
        .build({ intent, quote, amountIn: 2_000_000n, minOutput: 6_100n });
      expect(pool.built).to.have.length(1);
      expect(pool.built[0].accounts.payer.equals(vaultAuthority)).to.equal(true);
      expect(pool.built[0].accounts.inputTokenAccount.equals(vault)).to.equal(true);
      expect(pool.built[0].accounts.outputTokenAccount.equals(stockAccount)).to.equal(true);
      expect(pool.built[0].minimumOut).to.equal(6_100n);
      expect(route.programId.equals(pool.programId)).to.equal(true);
    });

    it("needs no signature from this process: the PDA's flag is cleared and nothing else is signed", async () => {
      const route = await new DbcRouteBuilder({ pool: new FakePool(), vaultAuthority, vault, stockAccount })
        .build({ intent, quote, amountIn: 2_000_000n, minOutput: 6_100n });
      expect(route.signers ?? []).to.have.length(0);
      expect(route.accounts.filter((account) => account.isSigner)).to.have.length(0);
      // Cleared, not dropped: DBC still needs the account, in its place.
      expect(route.accounts.some((account) => account.pubkey.equals(vaultAuthority))).to.equal(true);
    });

    it("refuses a route that asks for any other signature", async () => {
      const pool = new FakePool();
      pool.extraSigner = key();
      let thrown: unknown;
      try {
        await new DbcRouteBuilder({ pool, vaultAuthority, vault, stockAccount }).build({ intent, quote, amountIn: 2_000_000n, minOutput: 6_100n });
      } catch (error) { thrown = error; }
      expect((thrown as Error).message).to.contain("signature other than the vault authority");
    });

    it("refuses to build for an instrument the curve does not sell", async () => {
      const pool = new FakePool();
      let thrown: unknown;
      try {
        await new DbcRouteBuilder({ pool, vaultAuthority, vault, stockAccount })
          .build({ intent: { instrumentMint: key().toBase58() } as StockTradeIntent, quote, amountIn: 2_000_000n, minOutput: 6_100n });
      } catch (error) { thrown = error; }
      expect((thrown as Error).message).to.contain("does not sell");
      expect(pool.built).to.have.length(0);
    });
  });

  describe("price", () => {
    it("puts the pool's spot on the tape as the token's own market", async () => {
      const pool = new FakePool();
      const source = new DbcPoolPriceSource(pool, () => 5_000);
      expect(source.side).to.equal("tokenized");
      const samples = await source.sample([instrument(key().toBase58()), instrument(CURVE_TOKEN)]);
      expect(samples).to.deep.equal([{ mint: CURVE_TOKEN, side: "tokenized", point: { t: 5_000, price: 324.5, source: "meteora-dbc-pool" } }]);
    });

    it("remembers what its last tick saw, so a monitor never has to ask the chain", async () => {
      const pool = new FakePool();
      let clock = 5_000;
      const source = new DbcPoolPriceSource(pool, () => clock);
      expect(source.latest()).to.equal(undefined);
      await source.sample([instrument(CURVE_TOKEN)]);
      expect(source.latest()).to.deep.equal({ observedAt: 5_000, graduated: false, priceUsd: 324.5, progress: 0.0005 });
      pool.graduated = true;
      clock = 5_020;
      await source.sample([instrument(CURVE_TOKEN)]);
      expect(source.latest()).to.deep.equal({ observedAt: 5_020, graduated: true });
    });

    it("keeps the last sighting when a read fails, and lets its age say so", async () => {
      const pool = new FakePool();
      const source = new DbcPoolPriceSource(pool, () => 5_000);
      await source.sample([instrument(CURVE_TOKEN)]);
      pool.spot = async () => { throw new Error("rpc down"); };
      let thrown: unknown;
      try { await source.sample([instrument(CURVE_TOKEN)]); } catch (error) { thrown = error; }
      expect((thrown as Error).message).to.equal("rpc down");
      expect(source.latest()?.observedAt).to.equal(5_000);
    });

    it("says nothing when the curve is not being watched, and nothing once it has graduated", async () => {
      const pool = new FakePool();
      const source = new DbcPoolPriceSource(pool);
      expect(await source.sample([instrument(key().toBase58())])).to.deep.equal([]);
      pool.graduated = true;
      expect(await source.sample([instrument(CURVE_TOKEN)])).to.deep.equal([]);
    });
  });
});
