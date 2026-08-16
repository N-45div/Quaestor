import type { Express } from "express";

/**
 * Standard-x402 payment lane, in parallel with the governed lane.
 *
 * The oracle's native settlement is Quaestor receipts (pay through the
 * governor, present the tx hash). This lane additionally serves the same
 * signal over the x402 Payment Protocol via OKX's facilitator, so any
 * x402-speaking buyer — OKX APP agents included — can pay without knowing
 * anything about Quaestor.
 *
 * Env-gated (X402_ENABLED=1) and fails soft: if the facilitator rejects the
 * network or the packages misbehave, the governed lane is untouched.
 */

export interface X402Options {
  payTo: string;
  network: string; // e.g. eip155:1952 (X Layer testnet)
  price: string; // e.g. "$0.01"
  signal: () => Record<string, unknown> | null;
}

export async function mountX402Lane(app: Express, opts: X402Options): Promise<boolean> {
  const apiKey = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;
  if (!apiKey || !secretKey || !passphrase) {
    console.log(
      "[x402] lane not mounted — needs OKX facilitator credentials " +
        "(OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE). Governed lane unaffected."
    );
    return false;
  }
  try {
    const { paymentMiddleware, x402ResourceServer } = await import("@okxweb3/x402-express");
    const { ExactEvmScheme } = await import("@okxweb3/x402-evm/exact/server");
    const { OKXFacilitatorClient } = await import("@okxweb3/x402-core");

    const facilitator = new OKXFacilitatorClient({
      apiKey,
      secretKey,
      passphrase,
      syncSettle: true,
    });
    const resourceServer = new x402ResourceServer(facilitator).register(
      opts.network,
      new ExactEvmScheme()
    );

    app.use(
      paymentMiddleware(
        {
          "GET /x402/signal": {
            accepts: {
              scheme: "exact",
              price: opts.price,
              network: opts.network,
              payTo: opts.payTo,
            },
            description:
              "QuaestorDEX market signal (spot, SMA, momentum) on X Layer — also payable through the Quaestor governor at /signal",
          },
        },
        resourceServer,
        undefined,
        undefined,
        false // don't block boot on facilitator sync
      )
    );

    app.get("/x402/signal", (_req, res) => {
      const s = opts.signal();
      if (!s) return res.status(503).json({ error: "no samples yet, retry shortly" });
      res.json({ signal: s, settlement: "x402/exact via OKX facilitator" });
    });

    console.log(
      `[x402] lane mounted — GET /x402/signal, ${opts.price} on ${opts.network} → ${opts.payTo}`
    );
    return true;
  } catch (err) {
    console.error(
      "[x402] lane NOT mounted (governed lane unaffected):",
      ((err as Error).message ?? String(err)).slice(0, 200)
    );
    return false;
  }
}
