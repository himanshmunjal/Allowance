import { Hono } from "hono";
import { requireMerchantKey } from "../http";
import { createQuote, QuoteInput, resolveQuote } from "../lib/quotes";

// API for external stores (D-051): the store creates a checkout quote with the item and price,
// hands the quote id to the shopping agent, and the agent buys it through request_purchase.

export const merchantRoutes = new Hono()
  .use("*", requireMerchantKey)
  .post("/quotes", async (c) => c.json(await createQuote(QuoteInput.parse(await c.req.json())), 201))
  .get("/quotes/:id", async (c) => {
    const quote = await resolveQuote(c.req.param("id"));
    return quote ? c.json(quote) : c.json({ error: "Quote not found or expired" }, 404);
  });
