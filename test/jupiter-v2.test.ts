import { expect } from "chai";
import { JupiterV2QuoteProvider } from "../stocks";

describe("Jupiter V2 quote adapter", () => {
  it("binds the raw build response to a stable quote and preserves min output", async () => {
    let requested = "";
    const provider = new JupiterV2QuoteProvider({
      taker: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
      now: () => 1_700_000_000,
      fetch: async (input) => {
        requested = String(input);
        return new Response(JSON.stringify(build()), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const quote = await provider.quote("USDC_MINT", "AAPL_MINT", 1_000_000n);
    expect(requested).to.include("/swap/v2/build?");
    expect(requested).to.include("amount=1000000");
    expect(quote.minimumOutput).to.equal(299_131n);
    expect(quote.outAmount).to.equal(300_634n);
    expect(quote.route).to.equal("Raydium CLMM");
    expect(quote.expiresAt).to.equal(1_700_000_020);
    expect(provider.buildFor(quote.quoteId)?.swapInstruction.programId).to.equal("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  });

  it("refuses an upstream response whose amount does not match the request", async () => {
    const provider = new JupiterV2QuoteProvider({
      taker: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
      fetch: async () => new Response(JSON.stringify({ ...build(), inAmount: "999999" }), { status: 200 }),
    });
    await expect(provider.quote("USDC_MINT", "AAPL_MINT", 1_000_000n)).to.be.rejectedWith("different mints or amount");
  });

  function build() {
    return {
      inputMint: "USDC_MINT",
      outputMint: "AAPL_MINT",
      inAmount: "1000000",
      outAmount: "300634",
      otherAmountThreshold: "299131",
      routePlan: [{ swapInfo: { ammKey: "amm-key", label: "Raydium CLMM" } }],
      setupInstructions: [],
      swapInstruction: {
        programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        accounts: [{ pubkey: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", isWritable: false, isSigner: true }],
        data: "AQID",
      },
      cleanupInstruction: null,
      addressesByLookupTableAddress: null,
    };
  }
});
