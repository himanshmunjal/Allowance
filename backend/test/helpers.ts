import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Tests run against their own database and a fake PayPal: never your .env, keys or data.

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/allowance_test";
process.env.PAYPAL_CLIENT_ID = "test-client";
process.env.PAYPAL_CLIENT_SECRET = "test-secret";
process.env.MERCHANT_API_KEY = "test-merchant-key";
process.env.DEMO_MODE = "on";
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CHANNEL3_API_KEY;
delete process.env.AGENT_API_KEY;

export type Fault = "none" | "drop-after-charge" | "drop-before-charge" | "html-502" | "declined";

/** A small stateful PayPal: charges once per PayPal-Request-Id, and can fail in the ways real networks do. */
export class FakePayPal {
  server!: Server;
  charges = 0;
  requests: { method: string; path: string; requestId: string | null; body: string }[] = [];
  /** Consumed one per create-order request; "none" once empty. */
  faults: Fault[] = [];
  captures = new Map<string, { status: string; amount: { currency_code: string; value: string } }>();
  webhookVerdict = "SUCCESS";
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
    json(404, { name: "NOT_FOUND", message: `fake PayPal has no ${req.method} ${path}` });
  }
}

export const closeDb = async () => {
  const pool = (globalThis as unknown as { allowancePool?: { end(): Promise<void> } }).allowancePool;
  if (pool) await pool.end();
};
