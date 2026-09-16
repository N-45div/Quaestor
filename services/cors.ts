import type { Express } from "express";

/** Cross-origin access for the public explorer and authenticated agent API. */
export function mountServiceCors(app: Express): void {
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Idempotency-Key, x-quaestor-tx",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    next();
  });
  app.options("*", (_req, res) => res.sendStatus(204));
}
