/**
 * A fetch that pays x402 challenges in USDC on Solana, settled through PayAI.
 *
 * Hand it to QuaestorStocksClient as `fetch` and a paid route just works: the
 * first request gets a 402 carrying the price, the payee and PayAI's fee payer;
 * this signs a USDC transfer for exactly that amount and retries; PayAI
 * verifies, submits, and pays the network fee. The agent needs USDC and nothing
 * else — no SOL.
 *
 * `lastPayment` keeps the most recent settlement, so an agent can show the
 * transaction it paid with alongside the data it paid for.
 */
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";

export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

export interface SolanaPaymentReceipt {
  transaction: string;
  network: string;
  payer?: string;
  success: boolean;
}

export interface SolanaPayingFetch {
  fetch: typeof fetch;
  payer: string;
  /** The most recent settlement this fetch paid for, if any. */
  lastPayment(): SolanaPaymentReceipt | undefined;
}

export interface SolanaPayingFetchOptions {
  /** The 64-byte Solana secret key the agent pays from. */
  secretKey: Uint8Array;
  /**
   * RPC for the blockhash a payment needs when the challenge does not carry
   * one. Leave unset and the public devnet endpoint is used, which throttles.
   */
  rpcUrl?: string;
  network?: string;
}

export async function solanaPayingFetch(options: SolanaPayingFetchOptions): Promise<SolanaPayingFetch> {
  const signer = await createKeyPairSignerFromBytes(options.secretKey);
  const client = new x402Client().register(
    (options.network ?? SOLANA_DEVNET_CAIP2) as `${string}:${string}`,
    new ExactSvmScheme(signer, { rpcUrl: options.rpcUrl }),
  );
  const paying = wrapFetchWithPayment(fetch, client);
  let last: SolanaPaymentReceipt | undefined;

  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await paying(input, init);
    const header = response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
    if (header) {
      try {
        const settled = decodePaymentResponseHeader(header);
        last = {
          transaction: settled.transaction,
          network: settled.network,
          payer: settled.payer,
          success: settled.success,
        };
      } catch {
        // A malformed receipt header does not make the data it came with wrong.
      }
    }
    return response;
  }) as typeof fetch;

  return { fetch: wrapped, payer: signer.address, lastPayment: () => last };
}
