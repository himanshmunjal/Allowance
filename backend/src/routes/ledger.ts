import { Hono } from "hono";
import { requireUser, type AppEnv } from "../http";
import { listAgents, publicAgent } from "../lib/agents";
import { listAuditEvents, listTransactions } from "../lib/db";
import { getPolicy, spendSummary } from "../lib/policy";
import { refundPurchase } from "../lib/purchase";
import { getWallet } from "../lib/wallet";

export const ledgerRoutes = new Hono<AppEnv>()
  .use("*", requireUser)
  // GET /api/transactions: the user's ledger + audit trail + budget + wallet + agents (polled by the dashboard).
  .get("/", async (c) => {
    const userId = c.var.user.id;
    const { policy } = await getPolicy(userId);
    const [transactions, events, spend, wallet, agents] = await Promise.all([
      listTransactions(userId, 50),
      listAuditEvents(userId, 60),
      spendSummary(userId, policy),
      getWallet(userId),
      listAgents(userId),
    ]);
    return c.json({ transactions, events, spend, wallet, agents: agents.map(publicAgent) });
  })
  // POST /api/transactions/:id/refund: human-only refund (D-014).
  .post("/:id/refund", async (c) => c.json({ transaction: await refundPurchase(c.var.user.id, c.req.param("id")) }));
