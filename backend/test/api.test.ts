import { FakePayPal, closeDb } from "./helpers";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { app } from "../src/app";
import { createAgent, ensureBuiltinAgent, type AgentContext } from "../src/lib/agents";
import { signUp } from "../src/lib/auth";
import { getTransaction, query, queryOne } from "../src/lib/db";
import { DEFAULT_POLICY, savePolicy } from "../src/lib/policy";
import { getAlertSettings, setAlertUrl } from "../src/lib/notify";
import { recoverStuckPayments, refundPurchase, requestPurchase } from "../src/lib/purchase";
import { assessRisk } from "../src/lib/risk";
import { getVaultId, setWalletConnected } from "../src/lib/wallet";

// The pipeline over real HTTP and a real database, with a fake PayPal that fails in realistic ways.

const paypal = new FakePayPal();
const lowRisk: typeof assessRisk = async () => ({ level: "low", matchesIntent: true, reason: "test" });
const email = () => `t-${randomBytes(5).toString("hex")}@test.invalid`;

async function account() {
  const user = await signUp(email(), "password-123");
  await savePolicy(user.id, DEFAULT_POLICY);
  await setWalletConnected(user.id, "vault_test", null, "buyer@test.invalid");
  return { user, chat: await ensureBuiltinAgent(user.id) };
}

const buy = (agent: AgentContext, productId = "p_cotton_socks") =>
  requestPurchase({ agent, productId, quantity: 1, userIntent: "socks", agentReason: "socks", source: "mcp" }, { assessRisk: lowRisk });

const orderCalls = () => paypal.requests.filter((r) => r.path === "/v2/checkout/orders" && r.method === "POST");

async function logIn(mail: string) {
  const res = await app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ email: mail, password: "password-123" }) });
  return res.headers.get("set-cookie")!.split(";")[0];
}

describe("payments when the network misbehaves", () => {
  before(() => paypal.start());
  after(async () => {
    await paypal.stop();
    await closeDb();
  });
  beforeEach(() => paypal.reset());

  it("pays once, and records the capture", async () => {
    const { chat } = await account();
    const r = await buy(chat);
    assert.equal(r.status, "PAID");
    assert.equal(paypal.charges, 1);
    assert.ok((await getTransaction(r.transactionId))?.paypalCaptureId);
  });

  it("a lost response doesn't charge twice: the retry reuses the request id", async () => {
    const { chat } = await account();
    paypal.faults = ["drop-after-charge"];
    const r = await buy(chat);
    assert.equal(r.status, "PAID");
    assert.equal(paypal.charges, 1, "charged exactly once");
    const ids = orderCalls().map((c) => c.requestId);
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1], "the retry used the same PayPal-Request-Id");
  });

  it("the first reason on a held purchase says why it was held", async () => {
    const { chat } = await account();
    await buy(chat);
    const repeat = await buy(chat);
    assert.equal(repeat.status, "PENDING_APPROVAL");
    assert.match(repeat.reasons[0], /accidental retry/);
  });

  it("survives an HTML 502 from a gateway", async () => {
    const { chat } = await account();
    paypal.faults = ["html-502"];
    assert.equal((await buy(chat)).status, "PAID");
    assert.equal(paypal.charges, 1);
  });

  it("an unknown outcome is PROCESSING, not 'failed: nothing was charged'", async () => {
    const { user, chat } = await account();
    paypal.faults = ["drop-after-charge", "drop-before-charge", "drop-before-charge"];
    const r = await buy(chat);
    assert.equal(r.status, "PROCESSING");
    assert.equal(paypal.charges, 1, "the money really did move");
    const row = await queryOne<{ total: number }>("SELECT SUM(amount) AS total FROM transactions WHERE user_id = $1 AND status = 'PROCESSING'", [user.id]);
    assert.equal(row?.total, 12, "it still reserves budget");

    // A minute later, the sweep settles it, without a second charge.
    await query("UPDATE transactions SET created_at = now() - interval '5 minutes' WHERE id = $1", [r.transactionId]);
    assert.ok((await recoverStuckPayments()) >= 1);
    const settled = await getTransaction(r.transactionId);
    assert.equal(settled?.status, "PAID");
    assert.ok(settled?.paypalCaptureId);
    assert.equal(paypal.charges, 1);
  });

  it("won't retry a payment too old for PayPal to deduplicate", async () => {
    const { chat } = await account();
    paypal.faults = ["drop-before-charge", "drop-before-charge", "drop-before-charge"];
    const r = await buy(chat);
    assert.equal(r.status, "PROCESSING");
    await query("UPDATE transactions SET created_at = now() - interval '4 hours' WHERE id = $1", [r.transactionId]);
    paypal.reset();
    await recoverStuckPayments();
    assert.equal(paypal.charges, 0);
    assert.equal((await getTransaction(r.transactionId))?.status, "PROCESSING");
    await query("DELETE FROM transactions WHERE id = $1", [r.transactionId]); // don't leave it for later sweeps
  });

  it("a definite decline asks the owner instead of failing, and isn't retried", async () => {
    const { chat } = await account();
    paypal.faults = ["declined"];
    const r = await buy(chat);
    assert.equal(r.status, "PENDING_APPROVAL");
    assert.match(r.reasons[0], /declined the charge.*Nothing was charged/);
    assert.ok(r.approvalUrl);
    assert.equal(orderCalls().length, 1);
    assert.equal(paypal.charges, 0);
  });

  it("a revoked saved PayPal falls back to approval and turns auto-pay off", async () => {
    const { user, chat } = await account();
    paypal.faults = ["token-gone"];
    const r = await buy(chat);
    assert.equal(r.status, "PENDING_APPROVAL");
    assert.match(r.reasons[0], /can no longer be charged/);
    assert.equal(paypal.charges, 0);
    assert.equal(await getVaultId(user.id), null, "auto-pay is off until it is reconnected");
    const tx = await getTransaction(r.transactionId);
    assert.ok(tx?.checks.some((c) => c.step === "wallet" && c.outcome === "ask"));
    // The next purchase doesn't even try: no wallet, so it asks.
    paypal.reset();
    const next = await buy(chat, "p_oat_milk");
    assert.equal(next.status, "PENDING_APPROVAL");
    assert.match(next.reasons.join(" "), /No PayPal wallet connected/);
    assert.equal(orderCalls().length, 0);
  });

  it("an unrelated PayPal error is still a real failure", async () => {
    const { chat } = await account();
    paypal.faults = ["bad-request"];
    assert.equal((await buy(chat)).status, "FAILED");
  });

  it("any 422 when creating the order asks the owner, even with an issue code we have never seen", async () => {
    const { user, chat } = await account();
    paypal.faults = ["business-error"];
    const r = await buy(chat);
    assert.equal(r.status, "PENDING_APPROVAL");
    assert.match(r.reasons[0], /would not take this payment.*A_NEW_BUSINESS_RULE/);
    assert.equal(paypal.charges, 0);
    assert.ok(await getVaultId(user.id), "the wallet is not blamed for a rule we can't identify");
  });

  it("a 422 at capture is never turned into a second payment", async () => {
    const { chat } = await account();
    paypal.faults = ["needs-capture"];
    paypal.captureError = true; // "order already captured": money may have moved
    const r = await buy(chat);
    assert.equal(r.status, "FAILED", "asking the owner to pay again here could charge twice");
    assert.equal(r.approvalUrl, undefined);
  });

  describe("refunds", () => {
    it("send our transaction id as custom_id, and a request id that makes a retry safe", async () => {
      const { user, chat } = await account();
      const paid = await buy(chat);
      assert.equal(paid.status, "PAID");
      const refunded = await refundPurchase(user.id, paid.transactionId);
      assert.equal(refunded.status, "REFUNDED");
      const call = paypal.requests.find((q) => q.path.endsWith("/refund"));
      assert.ok(call, "PayPal was asked to refund");
      assert.equal(call.requestId, `${paid.transactionId}-refund`);
      assert.equal(JSON.parse(call.body).custom_id, paid.transactionId);
    });

    it("a refund PayPal reports as FAILED leaves the purchase paid", async () => {
      const { user, chat } = await account();
      const paid = await buy(chat);
      paypal.refundStatus = "FAILED";
      await assert.rejects(() => refundPurchase(user.id, paid.transactionId), /could not complete this refund/);
      assert.equal((await getTransaction(paid.transactionId))?.status, "PAID");
    });

    it("a CANCELLED refund leaves it paid too", async () => {
      const { user, chat } = await account();
      const paid = await buy(chat);
      paypal.refundStatus = "CANCELLED";
      await assert.rejects(() => refundPurchase(user.id, paid.transactionId), /could not complete this refund/);
      assert.equal((await getTransaction(paid.transactionId))?.status, "PAID");
    });
  });

  it("twelve parallel requests can't beat the database lock", async () => {
    const { user, chat } = await account();
    await savePolicy(user.id, { ...DEFAULT_POLICY, weeklyBudget: 30 });
    const results = await Promise.all(Array.from({ length: 12 }, () => buy(chat)));
    assert.equal(paypal.charges, 1, "the retry guard holds under concurrency");
    assert.equal(results.filter((r) => r.status === "PAID").length, 1);
    const row = await queryOne<{ total: number }>("SELECT SUM(amount) AS total FROM transactions WHERE user_id = $1 AND status IN ('PAID','PROCESSING','PENDING_APPROVAL')", [user.id]);
    assert.ok((row?.total ?? 0) <= 30);
  });

  describe("who can do what", () => {
    it("an agent key can't approve, refund, or read another user's purchase", async () => {
      const { user, chat } = await account();
      const { apiKey } = await createAgent(user.id, { name: "Bot", weeklyBudget: null, autoPayLimit: null, allowedCategories: [], alwaysAsk: false });
      const pending = await requestPurchase({ agent: chat, productId: "p_candle_set", quantity: 1, userIntent: "x", agentReason: "x", source: "chat" });
      const headers = { Authorization: `Bearer ${apiKey}` };
      for (const path of [`/api/approvals/${pending.transactionId}/capture`, `/api/approvals/${pending.transactionId}/order`, `/api/transactions/${pending.transactionId}/refund`]) {
        assert.equal((await app.request(path, { method: "POST", headers, body: "{}" })).status, 401, path);
      }

      const stranger = await signUp(email(), "password-123");
      const cookie = await logIn(stranger.email);
      const res = await app.request(`/api/approvals/${pending.transactionId}`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 400);
      assert.match(await res.text(), /not found/i);
    });

    it("the price an agent sends over the API is ignored", async () => {
      const { user } = await account();
      const { apiKey } = await createAgent(user.id, { name: "Bot", weeklyBudget: null, autoPayLimit: null, allowedCategories: [], alwaysAsk: false });
      const res = await app.request("/api/agent/purchase", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ productId: "p_candle_set", quantity: 1, intent: "a gift", reason: "a gift", price: 0.01, amount: 0.01 }),
      });
      assert.equal(((await res.json()) as { amount: number }).amount, 34);
    });

    it("a revoked key stops working at once", async () => {
      const { user } = await account();
      const { agent, apiKey } = await createAgent(user.id, { name: "Bot", weeklyBudget: null, autoPayLimit: null, allowedCategories: [], alwaysAsk: false });
      const cookie = await logIn(user.email);
      assert.equal((await app.request(`/api/agents/${agent.id}`, { method: "DELETE", headers: { Cookie: cookie } })).status, 200);
      assert.equal((await app.request("/api/agent/status", { headers: { Authorization: `Bearer ${apiKey}` } })).status, 401);
    });
  });

  describe("webhooks", () => {
    const send = (event: unknown, raw?: string) =>
      app.request("/api/paypal/webhook", { method: "POST", body: raw ?? JSON.stringify(event), headers: { "paypal-transmission-id": "t" } });

    before(() => {
      process.env.PAYPAL_WEBHOOK_ID = "wh_test";
    });
    after(() => {
      delete process.env.PAYPAL_WEBHOOK_ID;
    });

    it("rejects a forged event", async () => {
      paypal.webhookVerdict = "FAILURE";
      assert.equal((await send({ id: `E${Date.now()}`, event_type: "PAYMENT.CAPTURE.DENIED", resource: { id: "x" } })).status, 401);
    });

    it("sends PayPal the event's exact bytes for verification", async () => {
      const raw = `{ "id":"E-raw-${randomBytes(4).toString("hex")}",  "event_type":"X.Y",\n"resource":{"id":"r","value":1.10} }`;
      assert.equal((await send(null, raw)).status, 200);
      const call = paypal.requests.find((r) => r.path === "/v1/notifications/verify-webhook-signature")!;
      assert.ok(call.body.includes(`"webhook_event":${raw}`), "body is not re-serialized");
    });

    it("removing Allowance in PayPal turns auto-pay off", async () => {
      const { user } = await account();
      const token = `vault_${randomBytes(5).toString("hex")}`;
      await setWalletConnected(user.id, token, null, null);
      await send({ id: `E-${token}`, event_type: "VAULT.PAYMENT-TOKEN.DELETED", resource: { id: token } });
      assert.equal(await getVaultId(user.id), null);
    });

    it("a dispute pauses the agent that made the purchase", async () => {
      const { user } = await account();
      const { agent } = await createAgent(user.id, { name: "Bot", weeklyBudget: null, autoPayLimit: null, allowedCategories: [], alwaysAsk: false });
      const r = await buy(agent);
      const tx = await getTransaction(r.transactionId);
      await send({ id: `E-${r.transactionId}`, event_type: "CUSTOMER.DISPUTE.CREATED", resource: { id: "PP-D-1", disputed_transactions: [{ seller_transaction_id: tx!.paypalCaptureId }] } });
      const row = await queryOne<{ status: string }>("SELECT status FROM agents WHERE id = $1", [agent.id]);
      assert.equal(row?.status, "paused");
    });
  });

  describe("one-click demo", () => {
    it("creates a populated account, with history outside the budget window", async () => {
      const res = await app.request("/api/demo/start", { method: "POST", headers: { "x-forwarded-for": "10.0.0.1" } });
      assert.equal(res.status, 201);
      const cookie = res.headers.get("set-cookie")!.split(";")[0];
      const ledger = (await (await app.request("/api/transactions", { headers: { Cookie: cookie } })).json()) as { transactions: { source: string; status: string }[]; spend: { spent: number; pending: number }; agents: unknown[] };
      assert.equal(ledger.spend.spent, 0, "sample history doesn't use up the budget");
      assert.equal(ledger.spend.pending, 79);
      assert.equal(ledger.agents.length, 4);
      assert.ok(ledger.transactions.some((t) => t.status === "PENDING_APPROVAL" && t.source === "chat"));
      assert.ok(ledger.transactions.some((t) => t.source === "sample"));

      const advice = (await (await app.request("/api/policy/suggestions", { headers: { Cookie: cookie } })).json()) as { suggestions: { id: string }[] };
      assert.deepEqual(advice.suggestions.map((s) => s.id).sort(), ["loosen-category:electronics", "tighten:gifts"]);
    });

    it("has no password anyone can log in with", async () => {
      const res = await app.request("/api/demo/start", { method: "POST", headers: { "x-forwarded-for": "10.0.0.2" } });
      const { user } = (await res.json()) as { user: { email: string } };
      const login = await app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ email: user.email, password: "!" }) });
      assert.equal(login.status, 401);
    });

    it("disconnecting doesn't revoke the shared sandbox wallet", async () => {
      process.env.DEMO_VAULT_ID = "vault_shared_demo";
      try {
        const res = await app.request("/api/demo/start", { method: "POST", headers: { "x-forwarded-for": "10.0.0.3" } });
        const cookie = res.headers.get("set-cookie")!.split(";")[0];
        paypal.reset();
        assert.equal((await app.request("/api/wallet", { method: "DELETE", headers: { Cookie: cookie } })).status, 200);
        assert.equal(paypal.requests.filter((r) => r.path.includes("payment-tokens")).length, 0);
      } finally {
        delete process.env.DEMO_VAULT_ID;
      }
    });

    it("is off for a live PayPal base", async () => {
      const [mode, base] = [process.env.DEMO_MODE, process.env.PAYPAL_API_BASE];
      delete process.env.DEMO_MODE;
      process.env.PAYPAL_API_BASE = "https://api-m.paypal.com";
      try {
        assert.equal((await app.request("/api/demo/start", { method: "POST" })).status, 403);
      } finally {
        process.env.DEMO_MODE = mode;
        process.env.PAYPAL_API_BASE = base;
      }
    });
  });

  describe("verify with PayPal", () => {
    it("catches a ledger that disagrees with PayPal", async () => {
      const { user, chat } = await account();
      const good = await buy(chat);
      const pending = await buy(chat, "p_beanie");
      assert.equal(pending.status, "PENDING_APPROVAL", "only captured payments are compared");

      const goodTx = await getTransaction(good.transactionId);
      paypal.captures.set(goodTx!.paypalCaptureId!, { status: "COMPLETED", amount: { currency_code: "USD", value: "99.00" } });

      const cookie = await logIn(user.email);
      const res = (await (await app.request("/api/transactions/reconcile", { method: "POST", headers: { Cookie: cookie } })).json()) as { checked: number; mismatches: number; rows: { note: string }[] };
      assert.equal(res.checked, 1);
      assert.equal(res.mismatches, 1);
      assert.match(res.rows[0].note, /amount differs/);
    });
  });

  describe("approval alerts", () => {
  type Hit = { headers: Record<string, string | string[] | undefined>; body: any };
  let receiver: Server;
  let url = "";
  let hits: Hit[] = [];
  let answer = 200;

  before(async () => {
    receiver = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        hits.push({ headers: req.headers, body: JSON.parse(raw || "{}") });
        res.writeHead(answer).end("ok");
      });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks/catch/1/secret-token/`;
  });
  after(async () => {
    receiver.closeAllConnections();
    await new Promise((r) => receiver.close(r));
  });
  beforeEach(() => {
    hits = [];
    answer = 200;
    paypal.reset();
  });

  const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
  async function until(n: number) {
    for (let i = 0; i < 40 && hits.length < n; i++) await settle(50);
  }

  it("tells the owner when a purchase needs their approval", async () => {
    const { user, chat } = await account();
    await setAlertUrl(user.id, url);
    const r = await buy(chat, "p_earbuds");
    assert.equal(r.status, "PENDING_APPROVAL");
    await until(1);
    assert.equal(hits.length, 1);
    const { body, headers } = hits[0];
    assert.equal(body.event, "approval_needed");
    assert.match(body.text, /Wireless Earbuds.*waiting for your approval/);
    assert.equal(body.purchase.id, r.transactionId);
    assert.equal(body.purchase.amount, 79);
    assert.match(body.approvalUrl, new RegExp(`/approve/${r.transactionId}$`));
    assert.match(String(headers["content-type"]), /application\/json/);
  });

  it("stays quiet when no address is set", async () => {
    const { chat } = await account();
    await buy(chat, "p_earbuds");
    await settle(300);
    assert.equal(hits.length, 0);
  });

  it("stays quiet for a blocked purchase", async () => {
    const { user, chat } = await account();
    await setAlertUrl(user.id, url);
    const r = await buy(chat, "p_casino_credits");
    assert.equal(r.status, "BLOCKED");
    await settle(300);
    assert.equal(hits.length, 0);
  });

  it("tells the owner when a refused saved PayPal sends a purchase to them", async () => {
    const { user, chat } = await account();
    await setAlertUrl(user.id, url);
    paypal.faults = ["declined"];
    assert.equal((await buy(chat)).status, "PENDING_APPROVAL");
    await until(1);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].body.event, "approval_needed");
  });

  it("tells the owner when a payment fails", async () => {
    const { user, chat } = await account();
    await setAlertUrl(user.id, url);
    paypal.faults = ["bad-request"];
    assert.equal((await buy(chat)).status, "FAILED");
    await until(1);
    assert.equal(hits[0].body.event, "payment_failed");
    assert.match(hits[0].body.text, /failed.*Nothing was charged/);
  });

  it("never lets a broken receiver break a purchase", async () => {
    const { user, chat } = await account();
    await setAlertUrl(user.id, url);
    answer = 500;
    assert.equal((await buy(chat, "p_earbuds")).status, "PENDING_APPROVAL");
    await setAlertUrl(user.id, "http://127.0.0.1:1/nothing-listens-here");
    assert.equal((await buy(chat, "p_tea_sampler")).status, "PENDING_APPROVAL");
  });

  it("shows the owner where alerts go without revealing the secret part of the address", async () => {
    const { user } = await account();
    await setAlertUrl(user.id, url);
    assert.deepEqual(await getAlertSettings(user.id), { configured: true, host: "127.0.0.1" });
    const cookie = await logIn(user.email);
    const res = await app.request("/api/notify", { headers: { cookie } });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.doesNotMatch(text, /secret-token/);
    await setAlertUrl(user.id, null);
    assert.deepEqual(await getAlertSettings(user.id), { configured: false, host: null });
  });

  it("only a logged-in parent can change it, and a bad address is refused with a reason", async () => {
    const { user } = await account();
    assert.equal((await app.request("/api/notify", { method: "PUT", body: JSON.stringify({ url: "https://hooks.zapier.com/x" }) })).status, 401);
    const cookie = await logIn(user.email);
    process.env.NOTIFY_ALLOW_PRIVATE = "off";
    try {
      const res = await app.request("/api/notify", { method: "PUT", headers: { cookie }, body: JSON.stringify({ url: "https://169.254.169.254/latest" }) });
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, /private network/);
    } finally {
      process.env.NOTIFY_ALLOW_PRIVATE = "on";
    }
  });

  it("the test button reports what the receiver said", async () => {
    const { user } = await account();
    const cookie = await logIn(user.email);
    await setAlertUrl(user.id, url);
    const ok = (await (await app.request("/api/notify/test", { method: "POST", headers: { cookie } })).json()) as { ok: boolean };
    assert.equal(ok.ok, true);
    assert.equal(hits.at(-1)?.body.event, "test");
  });
});
});
