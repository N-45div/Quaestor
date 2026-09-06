import * as dotenv from "dotenv";

dotenv.config();

/**
 * The herd moment, as a script: tenant B's permit price for a venue moves
 * because tenant A was attacked through it — without B doing anything.
 *
 *   npx ts-node scripts/herd-demo.ts [venue]
 *
 * Reads the 402 challenge for /v1/risk/check as tenant B, has tenant A report
 * the venue, then reads B's challenge again. Prints both prices with wall-clock
 * timestamps; the HCS-backed feed adds consensus timestamps to the same beat.
 *
 * Needs a running services process with X402_HEDERA_ENABLED=1 and
 * TENANT_KEYS containing `alpha:<key>` (HERD_TENANT_A_KEY).
 */
async function main() {
  const base = (process.env.SERVICES_URL ?? "http://localhost:8402").replace(/\/$/, "");
  const venue = process.argv[2] ?? "0x000000000000000000000000000000000000dEaD";
  const tenantA = process.env.HERD_TENANT_A ?? "alpha";
  const keyA = process.env.HERD_TENANT_A_KEY;
  if (!keyA) throw new Error("HERD_TENANT_A_KEY is required (the shared key for tenant A in TENANT_KEYS)");

  // The free quote is the same number the paid lane puts in its 402; using it
  // here means the demo runs against any host, whether or not a lane is on.
  const quoteFor = async (who: string) => {
    const r = await fetch(`${base}/v1/risk/quote?venue=${encodeURIComponent(venue)}`);
    if (r.status !== 200) throw new Error(`expected 200 from /v1/risk/quote, got ${r.status}`);
    const q = (await r.json()) as { permit: { hbar: string; tinybars: string; reporters: number } };
    const amt = BigInt(q.permit.tinybars);
    console.log(
      `${stamp()}  ${who} asks the permit price for ${venue}: ${q.permit.hbar} HBAR (${amt} tinybars, ${q.permit.reporters} reporter${q.permit.reporters === 1 ? "" : "s"})`
    );
    return amt;
  };

  const before = await quoteFor("tenant B");

  console.log(`${stamp()}  tenant A is attacked through ${venue} — A's agent reports it`);
  const rep = await fetch(`${base}/v1/threat/report`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-quaestor-tenant": tenantA,
      "x-quaestor-tenant-key": keyA,
    },
    body: JSON.stringify({ venue, pattern: "prompt-injection" }),
  });
  const repBody = (await rep.json()) as Record<string, unknown>;
  console.log(`${stamp()}  report → ${rep.status} ${JSON.stringify(repBody.permit_for_everyone)}`);

  const after = await quoteFor("tenant B");
  const factor = Number(after) / Number(before);
  console.log(
    `\n${stamp()}  B never touched anything. B's permit for ${venue} went ${before} → ${after} tinybars (×${factor}).` +
      `\n           If B's owner set an INFERENCE per-call cap below ${after} tinybars, the chain refuses B's next route through it.`
  );
}

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
