import { expect } from "chai";
import express from "express";
import type { Server } from "node:http";
import { mountSolanaPaymentLane, SOLANA_DEVNET_CAIP2, USDC_DEVNET_MINT } from "../services/x402solana";

/**
 * The lane against a stand-in facilitator, so it is tested offline and without
 * PayAI's availability deciding the result. The facilitator is the only thing
 * faked; the x402 resource server, the SVM scheme and the route matching are
 * the real ones.
 */
describe("Solana payment lane (x402 via PayAI)", () => {
  const PAY_TO = "6n1C3qGbRgFJv9Kem77sXLQPMJXS3kXAgN2w28JKi97a";
  const FEE_PAYER = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
  let facilitator: Server;
  let hub: Server;
  let base: string;
  let served = 0;

  const listen = (app: express.Express) =>
    new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const portOf = (s: Server) => (s.address() as { port: number }).port;

  before(async () => {
    const fake = express();
    fake.use(express.json());
    fake.get("/supported", (_req, res) => res.json({
      kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_DEVNET_CAIP2, extra: { feePayer: FEE_PAYER } }],
      extensions: [],
      signers: {},
    }));
    // Any payment presented is judged invalid: nothing here should ever reach
    // the paid handler.
    fake.post("/verify", (_req, res) => res.json({ isValid: false, invalidReason: "insufficient_funds" }));
    facilitator = await listen(fake);

    const app = express();
    mountSolanaPaymentLane(app, { payTo: PAY_TO, facilitatorUrl: `http://127.0.0.1:${portOf(facilitator)}` });
    app.get("/v1/stocks/prices/:instrumentMint", (_req, res) => { served += 1; res.json({ tape: true }); });
    app.get("/v1/stocks/venues", (_req, res) => res.json({ venues: [] }));
    hub = await listen(app);
    base = `http://127.0.0.1:${portOf(hub)}`;
  });

  after(() => {
    hub?.close();
    facilitator?.close();
  });

  const challenge = (response: Response) => {
    const header = response.headers.get("payment-required");
    expect(header, "a 402 must carry the payment requirements").to.be.a("string");
    return JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
  };

  it("answers an unpaid read of the tape with an exact-SVM challenge in devnet USDC", async () => {
    const response = await fetch(`${base}/v1/stocks/prices/AAPLx_MINT?window=1h`);
    expect(response.status).to.equal(402);
    const [accept] = challenge(response).accepts;
    expect(accept).to.include({
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_MINT,
      amount: "1000", // $0.001 in USDC's six decimals
      payTo: PAY_TO,
    });
    // The fee payer comes from the facilitator, which is why the agent never
    // needs SOL of its own.
    expect(accept.extra.feePayer).to.equal(FEE_PAYER);
  });

  it("matches the named mint parameter, so the route cannot be read for free", async () => {
    // A pattern that failed to match would let every request straight through.
    for (const mint of ["XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", "anything-else"]) {
      expect((await fetch(`${base}/v1/stocks/prices/${mint}`)).status).to.equal(402);
    }
    expect(served).to.equal(0);
  });

  it("does not serve the tape when the facilitator rejects the payment", async () => {
    const payment = Buffer.from(JSON.stringify({
      x402Version: 2,
      accepted: challenge(await fetch(`${base}/v1/stocks/prices/AAPLx_MINT`)).accepts[0],
      payload: { transaction: Buffer.from("not a real transaction").toString("base64") },
    })).toString("base64");
    const response = await fetch(`${base}/v1/stocks/prices/AAPLx_MINT`, { headers: { "payment-signature": payment } });
    expect(response.status).to.equal(402);
    expect(served).to.equal(0);
  });

  it("charges only the tape — governing a trade is never behind a paywall", async () => {
    expect((await fetch(`${base}/v1/stocks/venues`)).status).to.equal(200);
  });
});
