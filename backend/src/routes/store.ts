import { Hono } from "hono";
import { z } from "zod";
import { query } from "../lib/db";
import { createQuote } from "../lib/quotes";
import { getStoreProduct, STORE_NAME, storeProducts } from "../store/brew";

// The demo store's own server API (D-060), public like any shop's. It never touches the
// shopper's money: it creates a checkout quote (the STORE sets the price) and Allowance does the rest.

const Checkout = z.object({
  productId: z.string(),
  quantity: z.number().int().min(1).max(5).default(1),
});

export const storeRoutes = new Hono()
  .get("/products", (c) => c.json({ store: STORE_NAME, products: storeProducts }))
  // "Pay with Allowance": price the order server-side, then send the shopper to Allowance Checkout.
  .post("/checkout", async (c) => {
    const { productId, quantity } = Checkout.parse(await c.req.json());
    const product = getStoreProduct(productId);
    if (!product) return c.json({ error: "Unknown product" }, 404);
    const quote = await createQuote({
      merchant: STORE_NAME,
      item: product.name,
      price: product.price,
      category: product.category,
      description: product.description,
      sellerVerified: true,
      rating: product.rating,
      deliveryDays: product.deliveryDays,
    });
    const returnTo = `/store/order/${quote.quoteId}`;
    return c.json({
      quoteId: quote.quoteId,
      quantity,
      checkoutUrl: `/checkout/${quote.quoteId}?qty=${quantity}&return=${encodeURIComponent(returnTo)}`,
    });
  })
  // The store's view of its order: what Allowance decided (no buyer details).
  .get("/orders/:quoteId", async (c) => {
    const rows = await query<{ status: string; amount: number; quantity: number; title: string; agent_name: string | null; updated_at: string }>(
      `SELECT status, amount, quantity, title, agent_name, updated_at FROM transactions
       WHERE product_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [c.req.param("quoteId")],
    );
    return c.json({ store: STORE_NAME, order: rows[0] ?? null });
  });
