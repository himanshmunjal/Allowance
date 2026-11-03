import { Hono } from "hono";
import { z } from "zod";
import { requireUser, type AppEnv } from "../http";
import { listAgents, publicAgent } from "../lib/agents";
import { listAuditEvents, listTransactions } from "../lib/db";
import { askLedger, reconcile } from "../lib/explorer";
import { getPolicy, spendSummary } from "../lib/policy";
import { refundPurchase } from "../lib/purchase";
import { getWallet } from "../lib/wallet";

const MAX_EXPLORER_ROWS = 2000;

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
  // The spending explorer (D-066): the whole ledger for the grid.
  .get("/explorer", async (c) => c.json({ transactions: await listTransactions(c.var.user.id, MAX_EXPLORER_ROWS) }))
  // POST /api/transactions/ask: an English question → a grid view. The model never sees a transaction.
  .post("/ask", async (c) => {
    const { question } = z.object({ question: z.string().trim().min(2).max(300) }).parse(await c.req.json());
    return c.json(await askLedger(question, (await listAgents(c.var.user.id)).map((a) => a.name)));
  })
  // POST /api/transactions/reconcile: compare the ledger with PayPal's own record of each capture.
  .post("/reconcile", async (c) => c.json(await reconcile(await listTransactions(c.var.user.id, MAX_EXPLORER_ROWS))))
  // POST /api/transactions/:id/refund: human-only refund (D-014).
  .post("/:id/refund", async (c) => c.json({ transaction: await refundPurchase(c.var.user.id, c.req.param("id")) }));
