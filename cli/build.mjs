// Bundle the agent commands into one file each: cli/dist/quaestor.mjs (Base)
// and cli/dist/quaestor-sol.mjs (Solana devnet). Node 18 or later, no install.
// They are committed so an agent can fetch one by URL and run it, and left
// unminified on purpose, so anyone about to hand one a key can read it.
// esbuild comes from the app's dependencies; run `npm ci` in app/ first.
import { build } from "../app/node_modules/esbuild/lib/main.js";

// Dependencies still require a few Node builtins, and some name __filename;
// an ES module has neither of its own.
const banner = [
  "#!/usr/bin/env node",
  "import { createRequire as __cr } from 'node:module';",
  "import { fileURLToPath as __fu } from 'node:url';",
  "import { dirname as __dn } from 'node:path';",
  "const require = __cr(import.meta.url);",
  "const __filename = __fu(import.meta.url);",
  "const __dirname = __dn(__filename);",
].join("\n");

for (const [entry, outfile] of [["cli/quaestor.ts", "cli/dist/quaestor.mjs"], ["cli/quaestor-sol.ts", "cli/dist/quaestor-sol.mjs"]]) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    legalComments: "none",
    outfile,
    banner: { js: banner },
    logLevel: "warning",
  });
  console.log(`built ${outfile}`);
}
