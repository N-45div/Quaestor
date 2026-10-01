// Bundle each `mm quaestor` command into dist/commands/quaestor/<name>.js, with the Quaestor
// command line and ethers inside and MetaMask's plugin SDK left to the host (a peer dependency,
// so the import resolves to the running mm). Shared code goes to dist/lib, outside the folder
// oclif reads commands from. esbuild comes from the app's dependencies; run `npm ci` in app/ first.
import { readdirSync, rmSync } from "node:fs";
import { build } from "../../app/node_modules/esbuild/lib/main.js";

const banner = [
  "import { createRequire as __cr } from 'node:module';",
  "import { fileURLToPath as __fu } from 'node:url';",
  "import { dirname as __dn } from 'node:path';",
  "const require = __cr(import.meta.url);",
  "const __filename = __fu(import.meta.url);",
  "const __dirname = __dn(__filename);",
].join("\n");

rmSync("dist", { recursive: true, force: true });
const commands = readdirSync("src/commands/quaestor").filter((f) => f.endsWith(".ts"));
await build({
  entryPoints: Object.fromEntries(commands.map((f) => [`commands/quaestor/${f.replace(/\.ts$/, "")}`, `src/commands/quaestor/${f}`])),
  outdir: "dist",
  chunkNames: "lib/[name]-[hash]",
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@metamask/agent-wallet", "@metamask/agent-wallet/*"],
  legalComments: "none",
  banner: { js: banner },
  logLevel: "warning",
});
console.log(`built ${commands.length} commands into dist/commands/quaestor`);
