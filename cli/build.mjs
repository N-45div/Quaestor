// Bundle cli/quaestor.ts into cli/dist/quaestor.mjs: one file, Node 18 or later,
// no install. It is committed so an agent can fetch it by URL and run it.
// Left unminified on purpose, so anyone about to hand it a key can read it.
// esbuild comes from the app's dependencies; run `npm ci` in app/ first.
import { build } from "../app/node_modules/esbuild/lib/main.js";

await build({
  entryPoints: ["cli/quaestor.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  legalComments: "none",
  outfile: "cli/dist/quaestor.mjs",
  // ethers still requires a few Node builtins; an ES module has no `require` of its own.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log("built cli/dist/quaestor.mjs");
