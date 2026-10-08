import { expect } from "chai";
import { Keypair, PublicKey, type AccountMeta } from "@solana/web3.js";
import { DAMM_VENUE, DammQuoteProvider, DammRouteBuilder, dammPoolFor, type DammPool, type DammSwapAccounts } from "../stocks/damm-venue";
import { DBC_VENUE, DbcQuoteProvider, type DbcPool, type DbcSwapAccounts } from "../stocks/dbc-venue";
import { LifecyclePriceSource, LifecycleQuoteProvider, hasGraduated } from "../stocks/curve-lifecycle";
import { assessCurve } from "../stocks/dbc-launch";
import { curveView } from "../stocks/dbc-watch";
import { NoRouteError, resolveVenue } from "../stocks/venues";
import type { JupiterQuote, StockInstrument, StockTradeIntent } from "../stocks/types";

const key = () => Keypair.generate().publicKey;
const USDC = key().toBase58();
const TOKEN = key().toBase58();

/** A curve that fills until told it has graduated, and can be told to refuse a buy that is too large. */
class FakeCurve implements DbcPool {
  readonly baseMint = TOKEN;
  readonly quoteMint = USDC;
  readonly programId = key();
  graduated = false;
  tooLarge = false;
  async quoteBuy(amountIn: bigint, slippageBps: number) {
    if (this.graduated) throw new NoRouteError("this curve has graduated to a DAMM v2 pool and no longer fills");
    if (this.tooLarge) throw new NoRouteError("the curve cannot fill this buy: not enough left");
    const outAmount = (amountIn * 1_000n) / 344_527n;
    return { outAmount, minimumOutput: (outAmount * BigInt(10_000 - slippageBps)) / 10_000n, priceUsd: 324.53, progress: 0.0009 };
  }
  async spot() {
    return this.graduated ? undefined : { priceUsd: 324.53, progress: 0.0009 };
  }
  async swapInstruction(_accounts: DbcSwapAccounts) {
    return { keys: [] as AccountMeta[], data: Buffer.alloc(0) };
  }
}

/** The pool a curve graduates into: absent until the migration creates it. */
class FakeDammPool implements DammPool {
  readonly address = key().toBase58();
  readonly baseMint = TOKEN;
  readonly quoteMint = USDC;
  readonly programId = key();
  exists = false;
  priceUsd = 344.5271;
  extraSigner: PublicKey | null = null;
  built: Array<{ accounts: DammSwapAccounts; amountIn: bigint; minimumOut: bigint }> = [];
  async quoteBuy(amountIn: bigint, slippageBps: number) {
    if (!this.exists) throw new NoRouteError("the curve has not graduated: its DAMM v2 pool does not exist yet");
    const outAmount = BigInt(Math.floor((Number(amountIn) / this.priceUsd) * 0.9975));
    return { outAmount, minimumOutput: (outAmount * BigInt(10_000 - slippageBps)) / 10_000n, priceUsd: this.priceUsd };
  }
  async spot() {
    return this.exists ? { priceUsd: this.priceUsd } : undefined;
  }
  async swapInstruction(accounts: DammSwapAccounts, amountIn: bigint, minimumOut: bigint) {
    this.built.push({ accounts, amountIn, minimumOut });
    const keys: AccountMeta[] = [
      { pubkey: key(), isSigner: false, isWritable: true },
      { pubkey: accounts.inputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.outputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.payer, isSigner: true, isWritable: false },
      ...(this.extraSigner ? [{ pubkey: this.extraSigner, isSigner: true, isWritable: false }] : []),
    ];
    return { keys, data: Buffer.from([9]) };
  }
}

const graduate = (curve: FakeCurve, pool: FakeDammPool) => { curve.graduated = true; pool.exists = true; };
const instrument = (mint: string): StockInstrument => ({ symbol: "T", issuer: "test", mint, usdcMint: USDC, decimals: 6, enabled: true });
async function refusal(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); } catch (error) { return error; }
  return undefined;
}

describe("an anchored curve's graduation into Meteora DAMM v2", () => {
  describe("the graduated pool", () => {
    it("is known before the curve graduates: one address per pair, derived, not looked up", () => {
      const a = dammPoolFor(TOKEN, USDC);
      expect(a).to.equal(dammPoolFor(TOKEN, USDC));
      expect(a).to.not.equal(dammPoolFor(key().toBase58(), USDC));
      // The anchored curve's devnet launch, graduated on 8 Oct 2026, landed exactly here.
      expect(dammPoolFor("GWVTYLHS74NFkk8fBVTx9DdsPs17bxFCwmoqZhBSiLvc", "8HcqMLJJxoG3fAkgNk8Qm3Uv7oXhXLM8X5xE4FXZe3Cg")).to.equal("5cjRrMdhjtwULU7KpzDzMfpxxE5osx5CXaj3dVvWnKUV");
    });

    it("is a registered venue whose label fits the on-chain allowlist", () => {
      const venue = resolveVenue(DAMM_VENUE);
      expect(venue.programId).to.equal("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
      expect(Buffer.byteLength(venue.label)).to.be.at.most(16);
    });

    it("quotes its own floor and names itself, for its own pair only", async () => {
      const pool = new FakeDammPool();
      pool.exists = true;
      const quotes = new DammQuoteProvider({ pool, slippageBps: 50, quoteTtlSeconds: 90, now: () => 1_000 });
      const quote = await quotes.quote(USDC, TOKEN, 2_000_000n);
      expect(quote.venue).to.equal(DAMM_VENUE);
      expect(quote.minimumOutput).to.equal((quote.outAmount * 9_950n) / 10_000n);
      expect(quote.expiresAt).to.equal(1_090);
      expect(await refusal(() => quotes.quote(TOKEN, USDC, 2_000_000n))).to.be.instanceOf(NoRouteError);
    });

    it("answers no route, not a guess, while the pool does not exist", async () => {
      const quotes = new DammQuoteProvider({ pool: new FakeDammPool() });
      const thrown = await refusal(() => quotes.quote(USDC, TOKEN, 2_000_000n));
      expect(thrown).to.be.instanceOf(NoRouteError);
      expect((thrown as Error).message).to.contain("not graduated");
    });

    it("routes from the vault into the curve's own position, lending only the vault's PDA", async () => {
      const pool = new FakeDammPool();
      pool.exists = true;
      const vaultAuthority = key();
      const vault = key();
      const stockAccount = key();
      const intent = { instrumentMint: TOKEN } as StockTradeIntent;
      const route = await new DammRouteBuilder({ pool, vaultAuthority, vault, stockAccount })
        .build({ intent, quote: {} as JupiterQuote, amountIn: 2_000_000n, minOutput: 5_761n, venueMinOutput: 0n });
      expect(route.programId.equals(pool.programId)).to.equal(true);
      expect(pool.built[0].accounts.inputTokenAccount.equals(vault)).to.equal(true);
      expect(pool.built[0].accounts.outputTokenAccount.equals(stockAccount)).to.equal(true);
      // The refusal demonstration tells the venue to accept anything; the governor's floor still binds.
      expect(pool.built[0].minimumOut).to.equal(0n);
      expect(route.accounts.some((account) => account.isSigner)).to.equal(false);

      pool.extraSigner = key();
      const thrown = await refusal(() => new DammRouteBuilder({ pool, vaultAuthority, vault, stockAccount }).build({ intent, quote: {} as JupiterQuote, amountIn: 1n, minOutput: 1n }));
      expect((thrown as Error).message).to.contain("signature other than the vault authority");
    });
  });

  describe("the lifecycle", () => {
    it("quotes the curve while it fills and the pool once it has graduated", async () => {
      const curve = new FakeCurve();
      const pool = new FakeDammPool();
      const quotes = new LifecycleQuoteProvider({ curve, curveQuotes: new DbcQuoteProvider({ pool: curve }), poolQuotes: new DammQuoteProvider({ pool }) });
      expect((await quotes.quote(USDC, TOKEN, 2_000_000n)).venue).to.equal(DBC_VENUE);
      graduate(curve, pool);
      expect(await hasGraduated(curve)).to.equal(true);
      const after = await quotes.quote(USDC, TOKEN, 2_000_000n);
      expect(after.venue).to.equal(DAMM_VENUE);
      expect(after.route).to.contain("graduated pool");
    });

    it("never reads a refused buy as graduation: a buy too large for the curve stays the curve's answer", async () => {
      const curve = new FakeCurve();
      const pool = new FakeDammPool();
      pool.exists = true; // even with a pool at the derived address, the curve's own flag decides
      curve.tooLarge = true;
      const quotes = new LifecycleQuoteProvider({ curve, curveQuotes: new DbcQuoteProvider({ pool: curve }), poolQuotes: new DammQuoteProvider({ pool }) });
      const thrown = await refusal(() => quotes.quote(USDC, TOKEN, 60_000_000_000n));
      expect(thrown).to.be.instanceOf(NoRouteError);
      expect((thrown as Error).message).to.contain("cannot fill this buy");
    });

    it("puts the curve's price on the tape, then the graduated pool's, and says where the token went", async () => {
      const curve = new FakeCurve();
      const pool = new FakeDammPool();
      const tape = new LifecyclePriceSource(curve, pool, () => 100);
      expect((await tape.sample([instrument(TOKEN)]))[0].point.price).to.equal(324.53);
      expect(tape.latest()?.graduated).to.equal(false);
      graduate(curve, pool);
      const after = await tape.sample([instrument(TOKEN)]);
      expect(after[0].point.price).to.equal(344.5271);
      expect(after[0].side).to.equal("tokenized");
      expect(tape.latest()).to.deep.include({ graduated: true, progress: 1, priceUsd: 344.5271 });
      expect(tape.latest()?.graduatedInto).to.deep.equal({ venue: DAMM_VENUE, pool: pool.address });
      expect(await tape.sample([instrument(key().toBase58())])).to.deep.equal([]);
    });

    it("says nothing on the tape when migrated but the pool cannot be read yet", async () => {
      const curve = new FakeCurve();
      curve.graduated = true;
      const tape = new LifecyclePriceSource(curve, new FakeDammPool(), () => 100);
      expect(await tape.sample([instrument(TOKEN)])).to.deep.equal([]);
      expect(tape.latest()).to.deep.include({ graduated: true, priceUsd: undefined });
    });
  });

  describe("the issuer's view", () => {
    it("reports the graduated pool's price against the share, and where it trades", () => {
      const judged = assessCurve({ openingPriceUsd: 324.46, graduationPriceUsd: 344.53, anchoredToUsd: 334.49, graduated: true, poolPriceUsd: 344.5271, referenceUsd: 337.4 });
      expect(judged.health).to.equal("graduated");
      expect(judged.premiumBps).to.equal(211);
      expect(judged.rangePosition).to.equal(1);
      expect(judged.summary).to.contain("DAMM v2").and.to.contain("$344.53").and.to.contain("211 bps over");

      const view = curveView(
        { cluster: "devnet", pool: "curve", baseMint: TOKEN, symbol: "qAAPLdemo", anchoredToUsd: 334.49, bandBps: 300, openingPriceUsd: 324.46, graduationPriceUsd: 344.53, graduationUsdc: 50_734.02 },
        { observedAt: 100, graduated: true, progress: 1, priceUsd: 344.5271, graduatedInto: { venue: DAMM_VENUE, pool: "damm" } },
        337.4,
      );
      expect(view.health).to.equal("graduated");
      expect(view.graduated_into).to.deep.equal({ venue: DAMM_VENUE, pool: "damm" });
      expect(view.raised_usdc).to.equal(50_734.02);
    });
  });
});
