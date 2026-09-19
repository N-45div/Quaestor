/**
 * What a public Express service needs before strangers reach it.
 *
 * The hub was written for one operator on localhost. Hosted, it is a URL
 * anyone can hit, on a 512 MB instance, holding signing keys. Nothing here is
 * clever; it is the difference between "works" and "survives a curl loop".
 *
 * The limiter is in-repo rather than a dependency on purpose: it is forty
 * lines, it needs one behaviour the common packages make awkward (the MCP
 * tools call the hub over loopback, and must not share one bucket), and a
 * service that signs transactions should not grow its supply chain for that.
 */
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { safeMessage } from "../stocks/redact";

export interface RateLimitOptions {
  /** Requests allowed per window, per client. */
  limit: number;
  windowMs: number;
  /** A label for the 429 body, so a caller knows which budget it spent. */
  name: string;
  /** What identifies a client. Defaults to the proxy-aware IP. */
  key?: (req: Request) => string;
}

/**
 * What counts as one client. An IPv4 address is one; an IPv6 *address* is not —
 * a single host is routinely handed a whole /64, and keying on the full address
 * lets it mint a fresh bucket for every request.
 */
export function clientKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((group) => group.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** True for the MCP tools' own calls back into this process. */
export function isLoopback(req: Request): boolean {
  const remote = req.socket.remoteAddress ?? "";
  const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  // A proxied request also arrives from a private address on some hosts; only
  // a request with no forwarding header at all came from inside this process.
  return local && req.headers["x-forwarded-for"] === undefined;
}

/**
 * Fixed-window counter per client. Loopback is exempt: those calls were already
 * counted once, at the edge, when the agent's request came in.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, options.windowMs);
  sweep.unref?.();

  return (req: Request, res: Response, next: NextFunction) => {
    if (isLoopback(req)) return next();
    const now = Date.now();
    const key = options.key?.(req) ?? clientKey(req.ip);
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      // A map that strangers can grow needs a ceiling of its own. The oldest
      // entries go, not all of them: clearing the map would hand whoever
      // filled it a clean slate along with everyone else.
      if (hits.size >= 20_000) {
        let drop = 2_000;
        for (const stale of hits.keys()) {
          if (drop-- <= 0) break;
          hits.delete(stale);
        }
      }
      entry = { count: 0, resetAt: now + options.windowMs };
      hits.delete(key);
      hits.set(key, entry);
    }
    entry.count += 1;
    const remaining = Math.max(0, options.limit - entry.count);
    res.setHeader("RateLimit-Limit", String(options.limit));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil((entry.resetAt - now) / 1000)));
    if (entry.count > options.limit) {
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      res.status(429).json({
        error: { code: "RATE_LIMITED", message: `too many ${options.name} requests; retry after the window resets` },
      });
      return;
    }
    next();
  };
}

/** At most `max` requests in flight; the rest are told to come back. */
export function concurrencyLimit(max: number, name: string): RequestHandler {
  let inFlight = 0;
  return (req: Request, res: Response, next: NextFunction) => {
    if (inFlight >= max) {
      res.setHeader("Retry-After", "2");
      res.status(429).json({ error: { code: "BUSY", message: `${name} is at capacity; retry shortly` } });
      return;
    }
    inFlight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight -= 1;
    };
    res.on("finish", release);
    res.on("close", release);
    next();
  };
}

/** Call first, before any route. */
export function hardenApp(app: Express): void {
  // The number of proxies in front of this process, exactly. Too few and
  // every caller shares a proxy's address and one bucket; too many — or `true` —
  // and a caller forges X-Forwarded-For to pick their own. It depends on the
  // host, so it is configuration, and the first outside request is logged so it
  // can be checked against reality rather than assumed.
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  app.set("trust proxy", Number.isInteger(hops) && hops >= 0 ? hops : 1);
  let reported = false;
  app.use((req, _res, next) => {
    if (!reported && !isLoopback(req)) {
      reported = true;
      const chain = String(req.headers["x-forwarded-for"] ?? "").split(",").filter((part) => part.trim()).length;
      console.log(`[http] first outside request: ${chain} forwarded hop(s) seen, trusting ${hops}, client counted as ${clientKey(req.ip)}`);
    }
    next();
  });
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
}

/** Call last. Express's default handler answers in HTML, with a stack trace outside production. */
export function mountErrorHandlers(app: Express): void {
  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "no such route" } });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number; statusCode?: number })?.status
      ?? (error as { statusCode?: number })?.statusCode
      ?? 500;
    const clientError = status >= 400 && status < 500;
    if (!clientError) console.error("[http] unhandled:", safeMessage(error, 200));
    if (res.headersSent) return;
    res.status(clientError ? status : 500).json({
      error: {
        code: clientError ? "INVALID_REQUEST" : "INTERNAL_ERROR",
        message: clientError ? safeMessage(error, 160) : "internal error",
      },
    });
  });
}
