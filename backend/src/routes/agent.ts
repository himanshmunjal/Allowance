import { Hono } from "hono";
import { z } from "zod";
import { spendingStatus } from "../lib/agent";
import { searchCatalog } from "../lib/catalog";
import { listTransactions } from "../lib/db";
import { requestPurchase, withdrawPurchase } from "../lib/purchase";
import { requireAgentKey, type AppEnv } from "../http";

// API for external agents (used by the MCP server, D-010). Each agent sends its OWN key (D-054):
// it acts for that key's user, within that user's rules and the agent's allowance, through the
// exact same purchase pipeline as the chat agent.

const SearchBody = z.object({ query: z.string().default(""), maxPrice: z.number().optional(), category: z.string().optional() });
const PurchaseBody = z.object({
  productId: z.string(),
  quantity: z.number().int().default(1),
  intent: z.string().trim().min(3).max(1000),
  reason: z.string().trim().min(3).max(1000),
});

export const agentRoutes = new Hono<AppEnv>()
  .use("*", requireAgentKey)
  .post("/search", async (c) => c.json({ products: await searchCatalog(SearchBody.parse(await c.req.json())) }))
  .get("/status", async (c) => c.json(await spendingStatus(c.var.agent)))
  .post("/purchase", async (c) => {
    const body = PurchaseBody.parse(await c.req.json());
    return c.json(
      await requestPurchase({
        agent: c.var.agent,
        productId: body.productId,
        quantity: body.quantity,
        userIntent: body.intent,
        agentReason: body.reason,
        source: "mcp",
      }),
    );
  })
  // Withdraw this agent's own request that is still waiting for approval.
  .post("/purchases/:id/withdraw", async (c) => {
    const tx = await withdrawPurchase(c.var.agent, c.req.param("id"));
    return c.json({ id: tx.id, status: tx.status });
  })
  // Only this agent's own purchases: an agent can't see what the user's other agents bought.
  .get("/transactions", async (c) =>
    c.json({
      transactions: (await listTransactions(c.var.agent.userId, 20, c.var.agent.id)).map((t) => ({
        id: t.id,
        status: t.status,
        item: t.title,
        amount: t.amount,
        merchant: t.merchantName,
        reasons: t.decisionReasons,
        createdAt: t.createdAt,
      })),
    }),
  );
