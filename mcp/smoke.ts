import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Smoke test: drives the Quaestor MCP server over stdio exactly like Claude
 * or Cursor would — lists tools, reads status, then makes a real governed
 * paid-URL fetch. Run with the same env the server needs.
 */
async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["-r", "ts-node/register", "mcp/server.ts"],
    env: { ...process.env } as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name: "quaestor-smoke", version: "0.0.1" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

  const status = await client.callTool({ name: "quaestor_agent_status", arguments: {} });
  console.log("STATUS:", (status.content as any)[0].text.slice(0, 600));

  const oracle = process.env.ORACLE_URL ?? "https://quaestor-services-cjnm.onrender.com";
  const paid = await client.callTool({
    name: "quaestor_pay_url",
    arguments: {
      url: `${oracle}/signal`,
      purpose: "DATA",
      max_amount_okb: "0.0002",
      rationale:
        "MCP smoke test: buy one market signal through the governor to prove the pay_url flow end-to-end",
    },
  });
  console.log("PAY_URL:", (paid.content as any)[0].text.slice(0, 900));

  await client.close();
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
