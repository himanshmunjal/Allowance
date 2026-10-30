import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// The Allowance MCP tools, defined once (D-057) and served two ways:
//   - remote: POST /mcp on the backend (Streamable HTTP, agent key as Bearer token): src/mcp/http.ts
//   - local:  stdio process that forwards to the backend's HTTP API: mcp/server.ts
// Each transport supplies the five operations; the tool names, descriptions and inputs are shared.

export type AllowanceOps = {
  search(input: { query: string; maxPrice?: number; category?: string }): Promise<unknown>;
  status(): Promise<unknown>;
  purchase(input: { productId: string; quantity: number; intent: string; reason: string }): Promise<unknown>;
  withdraw(transactionId: string): Promise<unknown>;
  transactions(): Promise<unknown>;
};

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});
const run = async (fn: () => Promise<unknown>) => {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
};

export const SERVER_INFO = { name: "allowance", version: "1.1.0" };

export const SERVER_INSTRUCTIONS =
  "Allowance lets you buy things with the user's PayPal within rules they set. Search first, then request_purchase with a product id. " +
  "Prices come from the catalog (you never set one). Outcomes: PAID, PENDING_APPROVAL (give the user the approvalUrl), or BLOCKED (explain; never try to get around it).";

export function registerAllowanceTools(server: McpServer, ops: AllowanceOps) {
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
    ({ query, max_price, category }) => run(() => ops.search({ query, maxPrice: max_price, category })),
  );

  server.registerTool(
    "get_spending_status",
    {
      title: "Get spending status",
      description: "The user's spending rules and weekly budget, YOUR agent allowance (budget, limits, status), and whether auto-pay is enabled.",
      annotations: { readOnlyHint: true },
    },
    () => run(() => ops.status()),
  );

  server.registerTool(
    "request_purchase",
    {
      title: "Request a purchase",
      description:
        "Ask Allowance to buy a product with the user's PayPal. Allowance applies the user's rules, your agent allowance and an independent AI risk check, then pays (PAID), asks the user to approve (PENDING_APPROVAL, with approvalUrl), or refuses (BLOCKED, with reasons). Never try to get around a BLOCKED result.",
      inputSchema: {
        product_id: z.string().describe("Product id from search_products (or a q_… checkout quote id from a store)"),
        quantity: z.number().int().min(1).default(1),
        user_request: z.string().describe("What the user asked for, in their words"),
        reason: z.string().describe("Why this product fits the user's request"),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    ({ product_id, quantity, user_request, reason }) =>
      run(() => ops.purchase({ productId: product_id, quantity, intent: user_request, reason })),
  );

  server.registerTool(
    "withdraw_purchase_request",
    {
      title: "Withdraw a purchase request",
      description: "Cancel one of YOUR purchase requests that is still waiting for the user's approval (e.g. the user changed their mind). You can't approve purchases.",
      inputSchema: { transaction_id: z.string().describe("transactionId from request_purchase") },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    ({ transaction_id }) => run(() => ops.withdraw(transaction_id)),
  );

  server.registerTool(
    "list_transactions",
    {
      title: "List recent transactions",
      description: "Your recent Allowance purchases (this agent's only) with their status and the reasons behind each decision.",
      annotations: { readOnlyHint: true },
    },
    () => run(() => ops.transactions()),
  );
}
