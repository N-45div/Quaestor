/**
 * Quaestor on Bankr x402 Cloud.
 *
 * Bankr hosts this handler, puts the x402 paywall in front of it, and lists it
 * in its marketplace, so any Bankr agent can find it and pay for it in USDC on
 * Base. The handler itself does one thing: ask the Quaestor hub, which does the
 * work. It holds no key of consequence — only a server-to-server key that lets
 * the hub know payment was already taken.
 *
 * Bankr settles after the response, so a non-2xx here means the caller is not
 * charged for an answer they did not get.
 */
const configured = process.env.QUAESTOR_HUB_URL ?? "https://quaestor-stocks.onrender.com";
const HUB = configured.endsWith("/") ? configured.slice(0, -1) : configured;

function refuse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

async function ask(path: string, init: RequestInit, payer: string | null): Promise<Response> {
  const key = process.env.QUAESTOR_PROXY_KEY;
  if (!key) return refuse(503, "NOT_CONFIGURED", "this endpoint is not configured yet; you were not charged");
  let upstream: Response;
  try {
    upstream = await fetch(`${HUB}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), "x-quaestor-proxy-key": key, "x-402-payer": payer ?? "" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return refuse(502, "HUB_UNREACHABLE", "the Quaestor hub did not answer; you were not charged");
  }
  const body = await upstream.json().catch(() => null);
  if (body === null) return refuse(502, "HUB_UNREADABLE", "the Quaestor hub did not answer in JSON; you were not charged");
  // The hub's own 4xx (unknown instrument, malformed amounts) is the caller's to
  // read; anything else upstream is ours, and is not worth charging for.
  const status = upstream.ok ? 200 : upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
  return Response.json(body, { status });
}

export default async function handler(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const instrument = params.get("instrument");
  if (!instrument) return refuse(400, "INVALID_REQUEST", "pass ?instrument=AAPLx and optionally &window=1h");
  const window = params.get("window") ?? "1h";
  return ask(
    `/internal/intel/price-tape?instrument=${encodeURIComponent(instrument)}&window=${encodeURIComponent(window)}`,
    { method: "GET" },
    req.headers.get("x-402-payer"),
  );
}
