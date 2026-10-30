// Allowance MCP server (stdio). Lets any MCP client (e.g. Claude Desktop) shop through
// Allowance. Every purchase goes through the same rules + AI risk check + PayPal pipeline
// as the built-in chat agent (DECISION.md D-010).
//
// Run:  npm run mcp        (needs the backend running and AGENT_API_KEY set in backend/.env)
//
// stdout is the MCP protocol channel: log only to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Load the project's .env when present, so the MCP client config only needs the command.
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

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

const server = new McpServer({ name: "allowance", version: "1.0.0" });

server.registerTool(
  "search_products",
  {
    title: "Search products",
    description:
      "Search the Allowance catalog (live retailer products via Channel3, or the demo catalog). Returns product ids, prices (USD), ratings, delivery days, merchant and whether it is verified. Prices are re-checked when you buy.",
    inputSchema: {
      query: z.string().describe("What to look for, e.g. 'coffee beans'"),
      max_price: z.number().optional().describe("Optional maximum unit price in USD"),
      category: z.string().optional().describe("Optional: coffee, groceries, gifts, electronics, books, clothing, home, other"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, max_price, category }) => {
    try {
      return ok(await call("POST", "search", { query, maxPrice: max_price, category }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_spending_status",
  {
    title: "Get spending status",
    description: "The user's spending rules and weekly budget, YOUR agent allowance (budget, limits, status), and whether auto-pay is enabled.",
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      return ok(await call("GET", "status"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "request_purchase",
  {
    title: "Request a purchase",
    description:
      "Ask Allowance to buy a product with the user's PayPal. Allowance applies the user's rules and an independent AI risk check, then pays (PAID), asks the user to approve (PENDING_APPROVAL, with approvalUrl), or refuses (BLOCKED, with reasons). Never try to get around a BLOCKED result.",
    inputSchema: {
      product_id: z.string().describe("Product id from search_products"),
      quantity: z.number().int().min(1).default(1),
      user_request: z.string().describe("What the user asked for, in their words"),
      reason: z.string().describe("Why this product fits the user's request"),
    },
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  async ({ product_id, quantity, user_request, reason }) => {
    try {
      return ok(await call("POST", "purchase", { productId: product_id, quantity, intent: user_request, reason }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "withdraw_purchase_request",
  {
    title: "Withdraw a purchase request",
    description: "Cancel one of YOUR purchase requests that is still waiting for the user's approval (e.g. the user changed their mind). You can't approve purchases.",
    inputSchema: { transaction_id: z.string().describe("transactionId from request_purchase") },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  async ({ transaction_id }) => {
    try {
      return ok(await call("POST", `purchases/${encodeURIComponent(transaction_id)}/withdraw`));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "list_transactions",
  {
    title: "List recent transactions",
    description: "Your recent Allowance purchases (this agent's only) with their status and the reasons behind each decision.",
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      return ok(await call("GET", "transactions"));
    } catch (err) {
      return fail(err);
    }
  },
);

await server.connect(new StdioServerTransport());
console.error(`[allowance-mcp] ready → ${BASE_URL}`);
