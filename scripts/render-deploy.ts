import * as dotenv from "dotenv";

dotenv.config();

/**
 * Deploy the Render services from the current `main` and wait until they are
 * live. Auto-deploy does not fire in this workspace (the repo's GitHub webhook
 * belongs to an older Render account), so this is the push-to-live step:
 *
 *   git push origin main && npm run deploy:render          # hub + dashboard
 *   npm run deploy:render -- hub                            # just the hub
 *
 * Needs RENDER_API_KEY. Service ids default to the ETHOnline 2026 workspace and
 * can be overridden with RENDER_HUB_SERVICE_ID / RENDER_APP_SERVICE_ID.
 */
const SERVICES: Record<string, string> = {
  hub: process.env.RENDER_HUB_SERVICE_ID ?? "srv-daei8vn40ujc73fbk02g",
  app: process.env.RENDER_APP_SERVICE_ID ?? "srv-d9vnd68jo6nc73ast4h0",
};
const API = "https://api.render.com/v1";
const TERMINAL = new Set(["live", "build_failed", "update_failed", "canceled", "deactivated"]);

async function main() {
  const key = process.env.RENDER_API_KEY;
  if (!key) throw new Error("RENDER_API_KEY is required");
  const headers = { Authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" };
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SERVICES);

  const started = await Promise.all(
    wanted.map(async (name) => {
      const id = SERVICES[name];
      if (!id) throw new Error(`unknown service "${name}" (known: ${Object.keys(SERVICES).join(", ")})`);
      const r = await fetch(`${API}/services/${id}/deploys`, {
        method: "POST",
        headers,
        body: JSON.stringify({ clearCache: "do_not_clear" }),
      });
      if (!r.ok) throw new Error(`${name}: deploy request failed ${r.status} ${await r.text()}`);
      const d = (await r.json()) as { id: string; commit?: { id?: string } };
      console.log(`${name}  deploy ${d.id} started at ${(d.commit?.id ?? "").slice(0, 7)}`);
      return { name, id, deployId: d.id };
    })
  );

  const t0 = Date.now();
  const pending = new Map(started.map((s) => [s.name, s]));
  while (pending.size && Date.now() - t0 < 12 * 60_000) {
    await new Promise((r) => setTimeout(r, 5000));
    for (const [name, s] of [...pending]) {
      const r = await fetch(`${API}/services/${s.id}/deploys/${s.deployId}`, { headers });
      if (!r.ok) continue;
      const d = (await r.json()) as { status: string };
      if (TERMINAL.has(d.status)) {
        console.log(`${name}  ${d.status} after ${Math.round((Date.now() - t0) / 1000)}s`);
        pending.delete(name);
        if (d.status !== "live") process.exitCode = 1;
      }
    }
  }
  for (const name of pending.keys()) {
    console.log(`${name}  still deploying after 12 min — check the Render dashboard`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
