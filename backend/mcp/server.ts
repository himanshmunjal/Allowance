// Allowance MCP server (stdio). Lets any MCP client (e.g. Claude Desktop) shop through
// Allowance. Every purchase goes through the same rules + AI risk check + PayPal pipeline
// as the built-in chat agent (DECISION.md D-010).
//
// Run:  npm run mcp        (needs the backend running and AGENT_API_KEY set in backend/.env)
// Prefer no local process? Point the MCP client straight at https://<backend>/mcp (D-057).
//
// stdout is the MCP protocol channel: log only to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAllowanceTools, SERVER_INFO, SERVER_INSTRUCTIONS } from "../src/mcp/tools";

// Load the project's .env when present, so the MCP client config only needs the command.
// Variables already set (e.g. in the MCP client config) win over the file.
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// Talks to the backend API directly (not through the frontend proxy).
const BASE_URL = (process.env.ALLOWANCE_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`).replace(/\/$/, "");
const API_KEY = process.env.AGENT_API_KEY ?? "";

// AGENT_API_KEY = one agent's key from the Allowance dashboard (Agents → New agent). The agent
// acts for that key's user, within the user's rules and the agent's own allowance (D-054).
if (!API_KEY) {
  console.error("[allowance-mcp] AGENT_API_KEY is not set: create an agent in the Allowance dashboard and put its key in .env or the MCP client config.");
  process.exit(1);
}

async function call(method: "GET" | "POST", route: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/api/agent/${route}`, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Allowance API ${res.status}`);
  return json;
}

const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
registerAllowanceTools(server, {
  search: (input) => call("POST", "search", input),
  status: () => call("GET", "status"),
  purchase: (input) => call("POST", "purchase", input),
  withdraw: (id) => call("POST", `purchases/${encodeURIComponent(id)}/withdraw`),
  transactions: () => call("GET", "transactions"),
});

await server.connect(new StdioServerTransport());
console.error(`[allowance-mcp] ready → ${BASE_URL}`);
