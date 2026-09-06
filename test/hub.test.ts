import { expect } from "chai";
import type { Request } from "express";
import { PATTERNS, identify, tenantKeysFromEnv } from "../services/hub";

function req(headers: Record<string, string>, humanId?: string): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const r = { header: (name: string) => lower[name.toLowerCase()] } as unknown as Request;
  if (humanId) (r as Request & { humanId?: string }).humanId = humanId;
  return r;
}

describe("hub write gate", () => {
  const keys = tenantKeysFromEnv("alpha:correct-horse-battery,beta:staple-staple-staple");

  it("admits an onboarded tenant with the right key, as one reporter per tenant", () => {
    const who = identify(req({ "X-Quaestor-Tenant": "alpha", "X-Quaestor-Tenant-Key": "correct-horse-battery" }), keys);
    expect(who).to.deep.equal({ tier: "tenant", humanId: "tenant:alpha", tenantId: "alpha" });
  });

  it("refuses a wrong key, an unknown tenant, and a missing key", () => {
    expect(identify(req({ "X-Quaestor-Tenant": "alpha", "X-Quaestor-Tenant-Key": "nope-nope-nope" }), keys)).to.equal(null);
    expect(identify(req({ "X-Quaestor-Tenant": "gamma", "X-Quaestor-Tenant-Key": "correct-horse-battery" }), keys)).to.equal(null);
    expect(identify(req({ "X-Quaestor-Tenant": "alpha" }), keys)).to.equal(null);
    expect(identify(req({}), keys)).to.equal(null);
  });

  it("prefers a verified human over a tenant key, and keeps the human id as the reporter", () => {
    const who = identify(
      req({ "X-Quaestor-Tenant": "alpha", "X-Quaestor-Tenant-Key": "correct-horse-battery" }, "human:0xabc"),
      keys
    );
    expect(who).to.deep.equal({ tier: "human", humanId: "human:0xabc", tenantId: "alpha" });
  });

  it("a verified human needs no tenant at all", () => {
    expect(identify(req({}, "human:0xabc"), keys)).to.deep.equal({ tier: "human", humanId: "human:0xabc", tenantId: "anon" });
  });

  it("parses TENANT_KEYS and drops weak or malformed entries", () => {
    const m = tenantKeysFromEnv("alpha:correct-horse-battery, beta:short ,:nokey,gamma:staple-staple");
    expect([...m.keys()]).to.deep.equal(["alpha", "gamma"]);
    expect(tenantKeysFromEnv(undefined).size).to.equal(0);
  });

  it("only accepts known attack patterns", () => {
    expect(PATTERNS.has("prompt-injection")).to.equal(true);
    expect(PATTERNS.has("honeypot")).to.equal(true);
    expect(PATTERNS.has("lol")).to.equal(false);
  });
});
