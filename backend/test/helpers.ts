import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Tests run against their own database and a fake PayPal: never your .env, keys or data.

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/allowance_test";
process.env.PAYPAL_CLIENT_ID = "test-client";
process.env.PAYPAL_CLIENT_SECRET = "test-secret";
process.env.MERCHANT_API_KEY = "test-merchant-key";
process.env.DEMO_MODE = "on";
process.env.NOTIFY_ALLOW_PRIVATE = "on"; // tests post to a local receiver; the SSRF tests switch it off
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CHANNEL3_API_KEY;
delete process.env.AGENT_API_KEY;

export type Fault = "none" | "drop-after-charge" | "drop-before-charge" | "html-502" | "declined" | "token-gone" | "bad-request" | "business-error" | "needs-capture";

/** A small stateful PayPal: charges once per PayPal-Request-Id, and can fail in the ways real networks do. */
export class FakePayPal {
  server!: Server;
  charges = 0;
  requests: { method: string; path: string; requestId: string | null; body: string }[] = [];
  /** Consumed one per create-order request; "none" once empty. */
  faults: Fault[] = [];
  captures = new Map<string, { status: string; amount: { currency_code: string; value: string } }>();
  webhookVerdict = "SUCCESS";
  /** What the refund endpoint answers with: PayPal can accept a refund and still report it FAILED or CANCELLED. */
  refundStatus = "COMPLETED";
  /** Make the capture endpoint refuse, as PayPal does for an order that was already captured. */
  captureError = false;
  private orders = new Map<string, unknown>();

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    process.env.PAYPAL_API_BASE = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  reset() {
    this.charges = 0;
    this.requests = [];
    this.faults = [];
    this.webhookVerdict = "SUCCESS";
    this.refundStatus = "COMPLETED";
    this.captureError = false;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    let body = "";
    for await (const chunk of req) body += chunk;
    const path = req.url ?? "";
    const requestId = (req.headers["paypal-request-id"] as string) ?? null;
    this.requests.push({ method: req.method ?? "", path, requestId, body });
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };

    if (path === "/v1/oauth2/token") return json(200, { access_token: "tok", expires_in: 3600 });
    if (path === "/v1/notifications/verify-webhook-signature") return json(200, { verification_status: this.webhookVerdict });

    const capture = path.match(/^\/v2\/payments\/captures\/(.+)$/);
    if (capture && req.method === "GET") {
      const found = this.captures.get(capture[1]);
      return found ? json(200, { id: capture[1], ...found }) : json(404, { name: "RESOURCE_NOT_FOUND", message: "not found" });
    }

    if (path === "/v2/checkout/orders" && req.method === "POST") {
      const fault = this.faults.shift() ?? "none";
      if (fault === "drop-before-charge") return void req.socket.destroy();
      if (fault === "html-502") {
        res.writeHead(502, { "Content-Type": "text/html" });
        return void res.end("<html>Bad Gateway</html>");
      }
      if (fault === "token-gone") return json(404, { name: "RESOURCE_NOT_FOUND", message: "The specified resource does not exist.", details: [{ issue: "INVALID_RESOURCE_ID", description: "Vault id not found" }] });
      if (fault === "bad-request") return json(400, { name: "INVALID_REQUEST", message: "bad", details: [{ issue: "MALFORMED_REQUEST", description: "bad" }] });
      if (fault === "business-error") return json(422, { name: "UNPROCESSABLE_ENTITY", message: "business rule", details: [{ issue: "A_NEW_BUSINESS_RULE", description: "PayPal refused this order" }] });
      if (fault === "needs-capture") return json(201, { id: `ORDERNC${randomBytes(6).toString("hex")}`, status: "CREATED", purchase_units: [{ payments: { captures: [] } }] });
      if (fault === "declined") return json(422, { name: "UNPROCESSABLE_ENTITY", message: "declined", details: [{ issue: "INSTRUMENT_DECLINED", description: "declined" }] });

      const known = requestId ? this.orders.get(requestId) : undefined;
      if (known) return json(200, known); // idempotent: same id, same order, no new charge
      this.charges++;
      // Unique across reset() and across runs on the same database, like real PayPal ids.
      const unique = randomBytes(8).toString("hex");
      const id = `ORDER${unique}`;
      const captureId = `CAP${unique}`;
      const value = JSON.parse(body).purchase_units[0].amount.value as string;
      const order = {
        id,
        status: "COMPLETED",
        purchase_units: [{ payments: { captures: [{ id: captureId, status: "COMPLETED", amount: { currency_code: "USD", value } }] } }],
      };
      if (requestId) this.orders.set(requestId, order);
      this.captures.set(captureId, { status: "COMPLETED", amount: { currency_code: "USD", value } });
      if (fault === "drop-after-charge") return void req.socket.destroy(); // PayPal charged; the answer never arrives
      return json(201, order);
    }
    const orderCapture = path.match(/^\/v2\/checkout\/orders\/(.+)\/capture$/);
    if (orderCapture && req.method === "POST") {
      if (this.captureError) return json(422, { name: "UNPROCESSABLE_ENTITY", message: "already captured", details: [{ issue: "ORDER_ALREADY_CAPTURED", description: "Order already captured" }] });
      return json(201, { id: orderCapture[1], status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: `CAP${randomBytes(6).toString("hex")}`, status: "COMPLETED", amount: { currency_code: "USD", value: "12.00" } }] } }] });
    }
    if (/^\/v2\/payments\/captures\/.+\/refund$/.test(path) && req.method === "POST") return json(201, { id: `REF${randomBytes(6).toString("hex")}`, status: this.refundStatus });
    json(404, { name: "NOT_FOUND", message: `fake PayPal has no ${req.method} ${path}` });
  }
}

export const closeDb = async () => {
  const pool = (globalThis as unknown as { allowancePool?: { end(): Promise<void> } }).allowancePool;
  if (pool) await pool.end();
};
