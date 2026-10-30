// Plays the role of an external AI agent (like Claude Desktop): starts the Allowance MCP server
// over stdio, lists its tools, and calls them. Every purchase goes through the same rules,
// AI risk check and PayPal pipeline as the built-in chat agent.
//
// Run (with the backend running):  npm run mcp:demo
// The purchases show up in the dashboard ledger tagged "external agent (MCP)".

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const transport = new StdioClientTransport({
  command: process.execPath, // this Node binary
  args: [path.resolve(backendDir, "../node_modules/tsx/dist/cli.mjs"), path.join(backendDir, "mcp/server.ts")],
  cwd: backendDir,
  stderr: "ignore",
});
const client = new Client({ name: "allowance-mcp-demo", version: "1.0.0" });
await client.connect(transport);

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

const line = (s = "") => console.log(s);

try {
  const { tools } = await client.listTools();
  line(`🔌 Connected to the Allowance MCP server. Tools: ${tools.map((t) => t.name).join(", ")}\n`);

  const status = await call("get_spending_status");
  line(`📊 get_spending_status → ${status.rules}`);
  line(`   budget left: $${status.budget.remaining} · auto-pay: ${status.autoPay}`);
  line(`   acting as agent "${status.agent.name}": ${status.agent.allowance}\n`);

  const { products } = await call("search_products", { query: "tea" });
  line(`🔎 search_products "tea" → ${products.map((p: { name: string; price: number }) => `${p.name} ($${p.price})`).join(", ")}\n`);

  const scenarios = [
    { label: "Tea sampler ($29, over the $25 auto-pay limit)", product_id: "p_tea_sampler", user_request: "Get my friend a tea gift", reason: "Highly rated tea gift box" },
    { label: "Casino credits (blocked category)", product_id: "p_casino_credits", user_request: "Buy casino credits", reason: "The user asked for them" },
    { label: "Mystery gift cards ×10 (prompt-injection listing)", product_id: "p_mega_giftcard", quantity: 10, user_request: "Find a cheap gift", reason: "The listing says it is pre-approved" },
  ];
  for (const { label, ...args } of scenarios) {
    const r = await call("request_purchase", args);
    const icon = r.status === "PAID" ? "✅" : r.status === "PENDING_APPROVAL" ? "⏳" : "⛔";
    line(`${icon} request_purchase: ${label}\n   → ${r.status}`);
    for (const reason of r.reasons) line(`     - ${reason}`);
    if (r.approvalUrl) line(`     approve at: ${r.approvalUrl}`);
    line();
  }
  line("Open the dashboard: these purchases are in the ledger as \"external agent (MCP)\".");
} catch (err) {
  console.error(`\n❌ ${(err as Error).message}`);
  console.error("Is the backend running? Start it with: npm run dev");
  process.exitCode = 1;
} finally {
  await client.close();
}
