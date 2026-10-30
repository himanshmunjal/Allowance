import { Hono } from "hono";
import { z } from "zod";
import { requireUser, type AppEnv } from "../http";
import { getAgent, listAgents, publicAgent } from "../lib/agents";
import { getOwnTransaction, PurchaseInputError, requestPurchase } from "../lib/purchase";
import { resolveQuote } from "../lib/quotes";

// Allowance Checkout (D-060): where a store's "Pay with Allowance" lands. The logged-in user picks
// which of their agents is buying; the purchase then runs the normal pipeline (rules, the agent's
// allowance, injection screen, AI risk check, PayPal), exactly like an agent's request_purchase.

const Pay = z.object({
  agentId: z.string(),
  quantity: z.number().int().min(1).max(5).default(1),
  intent: z.string().trim().min(3).max(1000),
});

export const checkoutRoutes = new Hono<AppEnv>()
  .use("*", requireUser)
  .get("/:quoteId", async (c) => {
    const quote = await resolveQuote(c.req.param("quoteId"));
    if (!quote) return c.json({ error: "This checkout has expired or doesn't exist. Go back to the store and try again." }, 404);
    const agents = (await listAgents(c.var.user.id)).map(publicAgent);
    return c.json({ product: quote.product, merchant: quote.merchant, agents });
  })
  .post("/:quoteId", async (c) => {
    const body = Pay.parse(await c.req.json());
    const agent = await getAgent(c.var.user.id, body.agentId);
    if (!agent || agent.status === "revoked") throw new PurchaseInputError("Pick one of your agents.");
    const result = await requestPurchase({
      agent,
      productId: c.req.param("quoteId"),
      quantity: body.quantity,
      userIntent: body.intent,
      agentReason: `Checkout started on ${(await resolveQuote(c.req.param("quoteId")))?.merchant.name ?? "the store"} with "Pay with Allowance"`,
      source: "store",
    });
    return c.json({ result, transaction: await getOwnTransaction(c.var.user.id, result.transactionId) });
  });
