import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The site's pages live at real paths (quaestor.dev/outreach). A static host serves a path from its own index.html,
 * so each gets a copy of the app's; the app reads the path and draws the page.
 */
const SITE_PATHS = ["outreach", "trading", "explorer", "networks", "pricing"];
const sitePaths = (): Plugin => ({
  name: "site-paths",
  apply: "build",
  closeBundle() {
    const dist = (p: string) => fileURLToPath(new URL(`./dist/${p}`, import.meta.url));
    for (const p of SITE_PATHS) {
      mkdirSync(dist(p), { recursive: true });
      copyFileSync(dist("index.html"), dist(`${p}/index.html`));
    }
  },
});

export default defineConfig({
  plugins: [react(), sitePaths()],
  server: {
    port: 4180,
    // The Solana program client lives in ../solana/client.ts, shared with the
    // validator suite and the agent command, so the dev server may read it.
    fs: { allow: [".."] },
  },
  resolve: {
    // Its imports resolve from the app's own node_modules: a host that builds
    // only app/ has no root install, and one copy of web3.js keeps PublicKey a
    // single class across the app and the client.
    dedupe: ["@solana/web3.js", "@noble/hashes"],
    // "buffer" is also the name of a Node builtin, which Vite stubs out in a
    // browser build, so it is pointed at the app's own npm package by path. A
    // bare "buffer/" resolves from the importing file, and for the shared
    // client that is the repo root, which a host building only app/ lacks.
    alias: { buffer: fileURLToPath(new URL("./node_modules/buffer/index.js", import.meta.url)) },
  },
  // web3.js v1 still names Node's `global` in places.
  define: { global: "globalThis" },
});
