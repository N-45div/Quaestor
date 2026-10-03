/**
 * Give an agent a computer: an E2B desktop sandbox of its own, with a browser it
 * drives and a wallet that can only ask its governor to buy.
 *
 * On the sandbox:
 *   - the agent command, fetched from its pinned tag and checked against its
 *     sha256, makes the agent's key there: the key is born on the agent's
 *     computer and never leaves it;
 *   - Quaestor Wallet (computer/wallet.ts) on 127.0.0.1:8547, holding that key,
 *     whose account is the agent's governor;
 *   - Chrome, driven through Playwright MCP, on the sandbox's desktop, with the
 *     wallet's provider (computer/inject.js) in every page.
 *
 * The agent's brain (Claude Code, or any MCP client) connects to the browser at
 * the sandbox's MCP URL. The sandbox is created with public traffic off, so the
 * URL answers only requests carrying its access token. The owner can watch the
 * desktop live on a view-only stream.
 *
 * A new agent has no governor yet: this prints the owner's register link, waits
 * for the owner to sign it, and starts the wallet once the governor exists.
 *
 *   node cli/build.mjs      (once: bundles the wallet into computer/dist/quaestor-wallet.mjs)
 *   E2B_API_KEY=… QUAESTOR_EVM_NETWORK=monad-testnet npx ts-node computer/launch.ts \
 *     [--register "--budget USDG --deposit 20 --per-trade 5 --epoch-cap 20 --stocks TSLA"] \
 *     [--minutes 55] [--out computer-session.json]
 *   npx ts-node computer/launch.ts --kill <sandboxId>
 *
 * The session file it writes holds the MCP token and the stream's key: keep it
 * out of any repository.
 */
import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { Sandbox } from "@e2b/desktop";

const CLI_TAG = "cli-v7";
const CLI = `https://gitlab.com/ndivij2004/quaestor/-/raw/${CLI_TAG}/cli/dist/quaestor-evm.mjs`;
const NODE = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz";
const PLAYWRIGHT_MCP = "@playwright/mcp@0.0.83";
const HOME = "/home/user";
const Q = `${HOME}/quaestor`;
const KEY = `${HOME}/.quaestor/evm-operator.key`;
const MCP_PORT = 8931;
const WALLET_PORT = 8547;

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const log = (m: string) => console.error(`[computer] ${m}`);

async function run(sbx: Sandbox, cmd: string, timeoutMs = 180_000, envs: Record<string, string> = {}): Promise<string> {
  const r = await sbx.commands.run(cmd, { timeoutMs, envs: { PATH: `${HOME}/node/bin:/usr/local/bin:/usr/bin:/bin`, ...envs } });
  if (r.exitCode !== 0) throw new Error(`${cmd.slice(0, 80)}… exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(-400)}`);
  return r.stdout;
}

/** The agent command inside the sandbox, as JSON. */
async function cli(sbx: Sandbox, network: string, args: string): Promise<Record<string, unknown>> {
  const r = await sbx.commands.run(`node ${Q}/quaestor-evm.mjs ${args}`, {
    timeoutMs: 120_000,
    envs: { PATH: `${HOME}/node/bin:/usr/bin:/bin`, QUAESTOR_EVM_NETWORK: network, QUAESTOR_EVM_KEY_FILE: KEY },
  }).catch((e: { result?: { stdout: string } }) => e.result ?? { stdout: "{}" });
  return JSON.parse(r.stdout || "{}");
}

async function main() {
  const kill = arg("kill");
  if (kill) {
    await Sandbox.kill(kill);
    return log(`sandbox ${kill} stopped`);
  }
  const network = process.env.QUAESTOR_EVM_NETWORK ?? "robinhood-testnet";
  const minutes = Number(arg("minutes") ?? 55);
  const out = arg("out") ?? "computer-session.json";
  const here = path.dirname(__filename);

  log(`creating a desktop sandbox for ${minutes} minutes, public traffic off`);
  const sbx = await Sandbox.create({ timeoutMs: minutes * 60_000, network: { allowPublicTraffic: false }, metadata: { app: "quaestor-computer", network } });
  log(`sandbox ${sbx.sandboxId}`);

  // Node, the pinned agent command (checked), and the wallet with its provider.
  await run(sbx, `mkdir -p ${Q} ${HOME}/.quaestor && chmod 700 ${HOME}/.quaestor && curl -fsSL ${NODE} | tar -xJ -C ${HOME} && mv ${HOME}/node-v20.18.0-linux-x64 ${HOME}/node`, 300_000);
  await run(sbx, `cd ${Q} && curl -fsSLO ${CLI} && curl -fsSLO ${CLI}.sha256 && sha256sum -c quaestor-evm.mjs.sha256`);
  await sbx.files.write(`${Q}/quaestor-wallet.mjs`, fs.readFileSync(path.join(here, "dist", "quaestor-wallet.mjs"), "utf8"));
  await sbx.files.write(`${Q}/inject.js`, fs.readFileSync(path.join(here, "inject.js"), "utf8"));
  log("installing Playwright MCP");
  await run(sbx, `npm i -g ${PLAYWRIGHT_MCP} >/dev/null 2>&1`, 300_000);

  // The agent's key, made here.
  const made = await cli(sbx, network, "keygen");
  const operator = String(made.operator ?? (await cli(sbx, network, "whoami")).operator);
  log(`agent key ${operator}`);

  // Its governor: the owner opens it from the register link; this waits for it.
  let governors = ((await cli(sbx, network, "whoami")).governors as string[] | undefined) ?? [];
  if (!governors.length) {
    const reg = await cli(sbx, network, `register ${arg("register") ?? ""}`);
    console.log(JSON.stringify({ step: "owner-signs", registerUrl: reg.registerUrl, operator }, null, 2));
    log("waiting for the owner to open the governor (Ctrl-C to stop; the sandbox keeps running)");
    while (!governors.length) {
      await new Promise((r) => setTimeout(r, 15_000));
      governors = ((await cli(sbx, network, "whoami")).governors as string[] | undefined) ?? [];
    }
  }
  const governor = governors[0];
  log(`governor ${governor}`);

  // The wallet, then the browser, on the desktop.
  await sbx.commands.run(`node ${Q}/quaestor-wallet.mjs >> ${Q}/wallet.log 2>&1`, {
    background: true,
    envs: { PATH: `${HOME}/node/bin:/usr/bin:/bin`, QUAESTOR_EVM_NETWORK: network, QUAESTOR_EVM_KEY_FILE: KEY, QUAESTOR_EVM_GOVERNOR: governor, QUAESTOR_WALLET_PORT: String(WALLET_PORT) },
  });
  await run(sbx, `for i in $(seq 1 30); do curl -s -X POST 127.0.0.1:${WALLET_PORT} -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"quaestor_info"}' | grep -q governor && exit 0; sleep 1; done; cat ${Q}/wallet.log; exit 1`, 60_000);
  await sbx.commands.run(
    `playwright-mcp --port ${MCP_PORT} --host 0.0.0.0 --allowed-hosts '*' --browser chrome --user-data-dir ${HOME}/.agent-chrome ` +
      // One browser for every session, so the desktop shows it; sized to the desktop's 1024x768 screen.
      `--init-script ${Q}/inject.js --grant-permissions local-network-access --shared-browser-context --viewport-size 1024,660 >> ${Q}/mcp.log 2>&1`,
    { background: true, envs: { PATH: `${HOME}/node/bin:/usr/local/bin:/usr/bin:/bin`, DISPLAY: sbx.display } },
  );
  await run(sbx, `for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:${MCP_PORT}/mcp | grep -qv 000 && exit 0; sleep 1; done; cat ${Q}/mcp.log; exit 1`, 60_000);

  // What the agent's brain and the owner need.
  await sbx.stream.start({ requireAuth: true });
  const session = {
    sandboxId: sbx.sandboxId,
    network,
    operator,
    governor,
    expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    watch: sbx.stream.getUrl({ authKey: sbx.stream.getAuthKey(), viewOnly: true }),
    mcp: { mcpServers: { computer: { type: "http", url: `https://${sbx.getHost(MCP_PORT)}/mcp`, headers: { "e2b-traffic-access-token": sbx.trafficAccessToken ?? "" } } } },
  };
  fs.writeFileSync(out, JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.writeFileSync(out.replace(/\.json$/, "") + ".mcp.json", JSON.stringify(session.mcp, null, 2), { mode: 0o600 });
  log(`ready: agent ${operator}, governor ${governor}; MCP config ${out.replace(/\.json$/, "")}.mcp.json; watch the desktop at the "watch" URL in ${out}`);
}

main().catch((e) => {
  console.error(`[computer] ${(e as Error).message}`);
  process.exitCode = 1;
});
