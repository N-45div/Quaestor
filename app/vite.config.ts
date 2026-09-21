import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
    // browser build; the trailing slash asks for the npm package instead.
    alias: { buffer: "buffer/" },
  },
  // web3.js v1 still names Node's `global` in places.
  define: { global: "globalThis" },
});
