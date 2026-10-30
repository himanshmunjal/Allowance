import { Hono } from "hono";
import { audit, findTransactionBy, getTransaction, query, updateTransaction } from "../lib/db";
import { verifyWebhook } from "../lib/paypal";

// PayPal webhooks: signature-verified (D-023), de-duplicated, idempotent. A bonus, not a
// dependency: state is already updated from API responses (D-012).

type WebhookEvent = {
  id: string;
  event_type: string;
  summary?: string;
  resource: { id: string; status?: string; custom_id?: string; links?: { href: string; rel: string }[] };
};

export const webhookRoutes = new Hono().post("/", async (c) => {
  let event: WebhookEvent;
  try {
    event = JSON.parse(await c.req.text());
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }

  let verified = false;
  try {
    verified = await verifyWebhook(c.req.raw.headers, event);
  } catch (err) {
    console.error("[webhook] verification call failed", err);
  }
  // 401 makes PayPal retry later; unsigned/forged events never change state.
  if (!verified) return c.json({ error: "signature verification failed (is PAYPAL_WEBHOOK_ID set?)" }, 401);

  const fresh = await query("INSERT INTO webhook_events (id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id", [event.id]);
  if (fresh.length === 0) return c.json({ ok: true, duplicate: true });

  const r = event.resource;
  switch (event.event_type) {
    case "PAYMENT.CAPTURE.COMPLETED": {
      const tx = (r.custom_id && (await getTransaction(r.custom_id))) || (await findTransactionBy("paypal_capture_id", r.id));
      if (tx && (tx.status === "PROCESSING" || tx.status === "PENDING_APPROVAL")) {
        await updateTransaction(tx.id, { status: "PAID", paypalCaptureId: r.id });
      }
      await audit(tx?.userId ?? null, "WEBHOOK", `PayPal confirmed capture ${r.id} completed`, tx?.id ?? null, { eventId: event.id });
      break;
    }
    case "PAYMENT.CAPTURE.DENIED": {
      const tx = (r.custom_id && (await getTransaction(r.custom_id))) || (await findTransactionBy("paypal_capture_id", r.id));
      if (tx && tx.status !== "FAILED") await updateTransaction(tx.id, { status: "FAILED" });
      await audit(tx?.userId ?? null, "WEBHOOK", `PayPal denied capture ${r.id}`, tx?.id ?? null, { eventId: event.id });
      break;
    }
    case "PAYMENT.CAPTURE.REFUNDED": {
      // The resource is the refund; its "up" link points at the capture.
      const captureId = r.links?.find((l) => l.rel === "up")?.href.split("/").pop();
      const tx = captureId ? await findTransactionBy("paypal_capture_id", captureId) : null;
      if (tx && tx.status === "PAID") await updateTransaction(tx.id, { status: "REFUNDED", paypalRefundId: r.id });
      await audit(tx?.userId ?? null, "WEBHOOK", `PayPal confirmed refund ${r.id}`, tx?.id ?? null, { eventId: event.id });
      break;
    }
    default:
      await audit(null, "WEBHOOK", `PayPal event ${event.event_type}${event.summary ? `: ${event.summary}` : ""}`, null, { eventId: event.id });
  }
  return c.json({ ok: true });
});
