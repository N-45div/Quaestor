/**
 * MetaMask's RPC gateway does not answer every chain mm lists: for Monad testnet it says
 * "Invalid chainId", and mm reads the chain through that gateway while it prepares a transaction
 * (block, nonce, gas). mm takes the gateway's address from MM_INFURA_RPC_BASE_URL and calls
 * `<base>/<chainId>/<projectId>`.
 *
 * For the length of one wallet request, that address points at a loopback server that answers the
 * governor's chain from Quaestor's own RPCs, and nothing else. Signing, policy and broadcasting
 * stay in MetaMask's wallet service; the server only answers reads.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { Network } from "../../../sdk/evm-stocks";

const ANSWER_MS = 8_000;

async function forward(urls: string[], body: string): Promise<{ status: number; text: string }> {
  let failure = "no RPC answered";
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(ANSWER_MS) });
      return { status: r.status, text: await r.text() };
    } catch (err) {
      failure = `${url}: ${(err as Error).message}`;
    }
  }
  return { status: 502, text: JSON.stringify({ error: failure }) };
}

export async function withGateway<T>(n: Network, request: () => Promise<T>): Promise<T> {
  const urls = [n.rpcUrl, ...(n.rpcFallbacks ?? [])];
  const server = http.createServer(async (req, res) => {
    const chainId = Number((req.url ?? "").split("/")[1]);
    let body = "";
    for await (const chunk of req) body += chunk;
    if (chainId !== n.chainId) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `this gateway answers ${n.name} (${n.chainId}) only` }));
      return;
    }
    const out = await forward(urls, body);
    if (process.env.QUAESTOR_GATEWAY_LOG) {
      const method = (() => { try { return (JSON.parse(body) as { method?: string }).method; } catch { return "?"; } })();
      process.stderr.write(`gateway ${n.chainId} ${method} -> ${out.status} ${out.text.includes('"error"') ? out.text.slice(0, 200) : "ok"}\n`);
      if (process.env.QUAESTOR_GATEWAY_LOG === "body") process.stderr.write(`  ${body.slice(0, 1500)}\n`);
    }
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(out.text);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const before = process.env.MM_INFURA_RPC_BASE_URL;
  process.env.MM_INFURA_RPC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await request();
  } finally {
    if (before === undefined) delete process.env.MM_INFURA_RPC_BASE_URL;
    else process.env.MM_INFURA_RPC_BASE_URL = before;
    server.close();
  }
}
