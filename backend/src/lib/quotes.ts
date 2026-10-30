import { z } from "zod";
import type { Merchant, Product } from "./catalog";
import { CATEGORIES } from "./categories";
import { jsonb, newId, query, queryOne } from "./db";

// Merchant checkout quotes (DECISION.md D-051). An external website (the merchant, holding
// MERCHANT_API_KEY) states the item and price; an agent can then only reference the quote id.
// Same principle as D-005: the price always comes from the seller side, never from the agent.

export const QUOTE_PREFIX = "q_";
const TTL_MS = 24 * 60 * 60 * 1000;

export const QuoteInput = z.object({
  merchant: z.string().trim().min(2).max(80).describe("Store name or domain, e.g. shop.example.com"),
  item: z.string().trim().min(2).max(160),
  price: z.number().positive().max(10_000),
  category: z.enum(CATEGORIES).default("other"),
  description: z.string().trim().max(1000).default(""),
  url: z.url().optional(),
  sellerVerified: z.boolean().default(true),
  rating: z.number().min(0).max(5).nullable().default(null),
  deliveryDays: z.number().int().min(0).max(90).nullable().default(null),
});
export type QuoteInput = z.infer<typeof QuoteInput>;

export async function createQuote(input: QuoteInput) {
  const id = newId("q");
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  const clean = { ...input, price: Math.round(input.price * 100) / 100 };
  await query("INSERT INTO quotes (id, quote, expires_at) VALUES ($1, $2, $3)", [id, jsonb(clean), expiresAt]);
  return { quoteId: id, ...clean, expiresAt };
}

/** The quote as a catalog product + merchant, or undefined if unknown or expired. */
export async function resolveQuote(id: string): Promise<{ product: Product; merchant: Merchant } | undefined> {
  const row = await queryOne<{ id: string; quote: unknown }>("SELECT id, quote FROM quotes WHERE id = $1 AND expires_at > now()", [id]);
  if (!row) return undefined;
  const q = QuoteInput.parse(row.quote);
  const merchantId = `qm_${q.merchant.toLowerCase().replace(/[^a-z0-9.]+/g, "-")}`;
  return {
    merchant: { id: merchantId, name: q.merchant, verified: q.sellerVerified, blurb: "External store (checkout quote)" },
    product: {
      id: row.id,
      merchantId,
      name: q.item,
      description: q.description,
      price: q.price,
      category: q.category,
      rating: q.rating,
      deliveryDays: q.deliveryDays,
      emoji: "🛒",
      source: "quote",
      url: q.url,
    },
  };
}
