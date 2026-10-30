import { Hono } from "hono";
import { z } from "zod";
import { requireUser, type AppEnv } from "../http";
import { lookupForDisplay } from "../lib/catalog";
import { captureApprovedOrder, createApprovalOrder, getOwnTransaction, rejectPurchase } from "../lib/purchase";

// Approval pages: only the purchase's owner, logged in, can see, pay or reject it (D-053).

export const approvalRoutes = new Hono<AppEnv>()
  .use("*", requireUser)
  .get("/:id", async (c) => {
    const transaction = await getOwnTransaction(c.var.user.id, c.req.param("id"));
    const product = await lookupForDisplay(transaction.productId);
    return c.json({
      transaction,
      product: product
        ? { emoji: product.emoji, description: product.description, rating: product.rating, deliveryDays: product.deliveryDays, url: product.url ?? null, imageUrl: product.imageUrl ?? null }
        : null,
    });
  })
  // Called by the PayPal button's createOrder callback. Body (optional): { saveWallet: boolean }.
  .post("/:id/order", async (c) => {
    const raw = await c.req.text();
    const { saveWallet } = z.object({ saveWallet: z.boolean().default(false) }).parse(raw ? JSON.parse(raw) : {});
    return c.json({ orderId: await createApprovalOrder(c.var.user.id, c.req.param("id"), saveWallet) });
  })
  // Called by the PayPal button's onApprove callback.
  .post("/:id/capture", async (c) => {
    const { orderId } = z.object({ orderId: z.string().min(5) }).parse(await c.req.json());
    return c.json({ transaction: await captureApprovedOrder(c.var.user.id, c.req.param("id"), orderId) });
  })
  .post("/:id/reject", async (c) => c.json({ transaction: await rejectPurchase(c.var.user.id, c.req.param("id")) }));
