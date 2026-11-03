import { Hono } from "hono";
import { requireMember, type AppEnv } from "../http";
import { publicAgent } from "../lib/agents";
import { listTransactions } from "../lib/db";
import { withdrawPurchase } from "../lib/purchase";

// A child's own view (D-061): their allowance and their purchases only. They can cancel a request
// that is still waiting for a parent, but never approve, refund or change a rule.

export const kidRoutes = new Hono<AppEnv>()
  .use("*", requireMember)
  .use("*", async (c, next) => {
    if (c.var.role !== "child") return c.json({ error: "This view is for a child's login." }, 403);
    await next();
  })
  .get("/", async (c) =>
    c.json({ child: publicAgent(c.var.agent), transactions: await listTransactions(c.var.user.id, 30, c.var.agent.id) }),
  )
  .post("/purchases/:id/withdraw", async (c) => c.json({ transaction: await withdrawPurchase(c.var.agent, c.req.param("id")) }));
