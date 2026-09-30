/**
 * Verify contracts on Sourcify's v2 API, from Hardhat's own build info (the exact
 * compiler input). Blockscout explorers read Sourcify, so this is also how a
 * contract gets its source on an explorer whose API is behind a browser check.
 *
 *   npx ts-node scripts/verify-sourcify.ts <chainId> <address> <path:Contract> [creationTxHash]
 *
 * It submits, then polls the job until Sourcify answers.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const API = process.env.SOURCIFY_API_URL ?? "https://sourcify.dev/server";
const UA = "quaestor-verify/1.0 (+https://github.com/N-45div/Quaestor)";

function buildInfoFor(source: string): { input: unknown; solcLongVersion: string } {
  const dir = path.join(process.cwd(), "artifacts", "build-info");
  for (const f of fs.readdirSync(dir)) {
    const b = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (b.input?.sources?.[source]) return { input: b.input, solcLongVersion: b.solcLongVersion };
  }
  throw new Error(`no build info holds ${source}; run npx hardhat compile`);
}

async function main() {
  const [chainId, address, identifier, creationTransactionHash] = process.argv.slice(2);
  if (!chainId || !address || !identifier?.includes(":")) throw new Error("usage: <chainId> <address> <path:Contract> [creationTxHash]");
  const { input, solcLongVersion } = buildInfoFor(identifier.split(":")[0]);
  const res = await fetch(`${API}/v2/verify/${chainId}/${address}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ stdJsonInput: input, compilerVersion: solcLongVersion, contractIdentifier: identifier, creationTransactionHash }),
  });
  const job = (await res.json()) as { verificationId?: string; message?: string; customCode?: string };
  if (!res.ok || !job.verificationId) throw new Error(`Sourcify refused: ${res.status} ${job.customCode ?? ""} ${job.message ?? ""}`);
  console.log(`submitted ${identifier} at ${address} on ${chainId}: job ${job.verificationId}`);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = (await (await fetch(`${API}/v2/verify/${job.verificationId}`, { headers: { "user-agent": UA } })).json()) as {
      isJobCompleted?: boolean; contract?: { match?: string; creationMatch?: string; runtimeMatch?: string }; error?: { customCode?: string; message?: string };
    };
    if (s.isJobCompleted) {
      if (s.error) throw new Error(`Sourcify: ${s.error.customCode} ${s.error.message}`);
      console.log(`verified: match ${s.contract?.match}, creation ${s.contract?.creationMatch}, runtime ${s.contract?.runtimeMatch}`);
      return;
    }
  }
  throw new Error("Sourcify did not finish in two minutes; check the job later");
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
