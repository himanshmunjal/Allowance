# Allowance: Low-Level Design (LLD)

> High-level picture: [`architecture.png`](../architecture.png) (source: [`architecture.dot`](architecture.dot)).
> Why each choice was made: [`DECISION.md`](../DECISION.md). Build log: [`FLOW.md`](../FLOW.md).
> Public API: [`openapi.yaml`](openapi.yaml).

---

## 1. Goal and non-goals

**Goal.** Let an AI agent spend a user's money through PayPal while the user stays in control.
Every spend, whether from the built-in chat agent, a child's login, a store checkout or an external
agent over MCP, passes through **one** server-side pipeline, with one of three outcomes:

| Outcome | When | What happens in PayPal |
|---|---|---|
| **Auto-paid** | Within every rule and allowance, at or under the auto-pay limit, not a repeat or split, low AI risk, wallet connected | Order created with the vaulted PayPal token and captured server-side, with no popup |
| **Needs approval** | Above the auto-pay limit, an always-ask category or agent, a repeat or split, medium AI risk, or no wallet connected | Pending record; the owner approves on `/approve/:id` with the PayPal button |
| **Blocked** | Merchant not allowed, blocked category, over the cap, budget or allowance, injection found, age-restricted for a child, or high AI risk | Nothing touches PayPal; logged with the reason |

**Non-goals (hackathon scope).** Real merchants receiving funds (all sandbox payments settle to one
sandbox merchant account, D-009), shipping and fulfilment, email verification and password reset.

---

## 2. Repository layout

Two deployable apps in one repo (npm workspaces). The browser only talks to the frontend; the
frontend proxies `/api/*` to the backend, so both look like one origin.

```
browser ──► frontend (Next.js, :3000) ──/api/*──► backend (Hono, :4000) ──► PayPal / AI providers / Channel3 / PostgreSQL
MCP client ─────────────────────────────────────► backend /mcp (remote) or /api/agent/* (via the local stdio server)
```

```
/
├─ frontend/                          Next.js 16 App Router (UI only, no server logic)
│  ├─ app/
│  │  ├─ page.tsx                     Landing (logged out), dashboard (owner), kid home (child)
│  │  ├─ login/                       Log in, sign up, or start the demo
│  │  ├─ approve/[id]/                Human approval page (PayPal JS SDK v6 button)
│  │  ├─ lab/                         Attack Lab
│  │  ├─ explorer/                    Spending Explorer (AG Grid)
│  │  ├─ store/, checkout/[quoteId]/  Demo store and Allowance Checkout
│  │  └─ components/                  Landing, Dashboard, Header, Chat, RulesPanel, Ledger, AgentsPanel,
│  │                                  DecisionTimeline, KidHome, format.ts
│  ├─ next.config.ts                  rewrites /api/:path* → BACKEND_URL/api/:path*
│  └─ tsconfig.json                   alias @shared/* → ../backend/src/shared/* (type-only)
├─ backend/                           Node 22 + Hono, ESM, bundled by tsup → dist/server.js
│  ├─ src/
│  │  ├─ server.ts                    entry point; also runs the stuck-payment sweep every minute
│  │  ├─ app.ts                       mounts routers, CORS, request log, error handler
│  │  ├─ http.ts                      error → HTTP mapping, session and key middleware
│  │  ├─ routes/                      see §9
│  │  ├─ mcp/                         tools.ts + ops.ts (shared definitions), http.ts (remote /mcp)
│  │  ├─ store/brew.ts                the demo store's catalog
│  │  ├─ lib/
│  │  │  ├─ purchase.ts               THE purchase pipeline (the only code path that spends money)
│  │  │  ├─ policy.ts                 Policy schema, defaults, evaluatePolicy(), spend summary
│  │  │  ├─ injection.ts              deterministic prompt-injection screen
│  │  │  ├─ velocity.ts               retry, split and burst guard
│  │  │  ├─ child-safety.ts           kid-safe check
│  │  │  ├─ risk.ts                   AI intent / risk check
│  │  │  ├─ redteam.ts                Attack Lab scenarios
│  │  │  ├─ demo.ts                   one-click demo accounts
│  │  │  ├─ advisor.ts                rule advisor
│  │  │  ├─ explorer.ts               ledger questions, reconciliation with PayPal
│  │  │  ├─ agent.ts                  tool-use loop for the chat agent (any provider)
│  │  │  ├─ rules-parser.ts           English → Policy
│  │  │  ├─ agents.ts, auth.ts, passwords.ts   agents and children, accounts and sessions, scrypt
│  │  │  ├─ paypal.ts, wallet.ts      PayPal REST client; vaulted wallet state (never leaves the server)
│  │  │  ├─ catalog.ts, channel3.ts, quotes.ts, categories.ts   where products and prices come from
│  │  │  ├─ config.ts, db.ts          env access; PostgreSQL pool, migrations, audit log
│  │  │  └─ llm/                      provider-neutral AI layer: Gemini, Groq, Claude + fallback
│  │  └─ shared/types.ts              API types shared with the frontend (no runtime code)
│  ├─ mcp/server.ts                   stdio MCP server → /api/agent/*
│  ├─ scripts/                        check-ai, mcp-demo, external-buy, redteam
│  └─ test/                           unit, attack and API tests with a fake PayPal
├─ docs/                              LLD.md, openapi.yaml, architecture.dot
├─ docker/, docker-compose.yml        local PostgreSQL and the test database
├─ .github/workflows/ci.yml           typecheck, lint, tests, build
└─ architecture.png, DECISION.md, FLOW.md, README.md, SUBMISSION.md, LICENSE, render.yaml, package.json
```

---

## 3. Data model (PostgreSQL, D-055)

The schema lives in `backend/src/lib/db.ts` (`migrate`) and is applied on startup with
`CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`. Money is `NUMERIC(12,2)`, times are
`TIMESTAMPTZ`, structured values are `JSONB`.

| Table | Holds | Notes |
|---|---|---|
| `users` | id, email, password_hash, `is_demo` | `is_demo` rows are deleted after 24 hours (D-067). Their hash is `!`, which never verifies |
| `sessions` | SHA-256 of the cookie token, user_id, `agent_id`, expires_at | `agent_id` set = a child's session (D-061) |
| `policies` | user_id, policy, source_text | One row per user. See §4 |
| `wallets` | user_id, status, setup_token_id, payment_token_id (the vault id), customer_id, payer_email | One row per user |
| `agents` | id, user_id, name, kind (`builtin`, `external`, `child`), key_hash, key_hint, login_name, password_hash, weekly_budget, auto_pay_limit, allowed_categories, always_ask, status, last_used_at | Keys are stored as SHA-256; revoking clears the hash |
| `transactions` | Who (user, agent), what (merchant, product, title, `category`, quantity, unit_price, amount), why (user_intent, agent_reason, decision_reasons, `checks`, risk), status, PayPal ids | `source`: `chat`, `mcp`, `store`, `sample` (labelled demo history), `lab` (Attack Lab only) |
| `audit_events` | user_id, tx_id, type, message, data | Append-only |
| `conversations` | (user_id, id), messages | A child's chats use a separate id |
| `quotes` | id, quote, expires_at | Store-set prices, valid 24 hours |
| `webhook_events` | PayPal event id | De-duplicates retries |

**Status values:** `PROCESSING`, `PAID`, `PENDING_APPROVAL`, `BLOCKED`, `REJECTED`, `REFUNDED`, `FAILED`.
`PROCESSING`, `PAID` and `PENDING_APPROVAL` count against budgets, in a rolling 7-day window.

---

## 4. Policy

```ts
type Policy = {
  weeklyBudget: number;              // rolling 7 days; paid and pending both count
  autoApproveLimit: number;          // at or under this → may auto-pay
  perPurchaseMax: number;            // hard cap; above → BLOCK
  allowedMerchants: string[];        // merchant ids; empty = any
  blockedCategories: Category[];     // → BLOCK
  approvalCategories: Category[];    // always → NEEDS_APPROVAL
  categoryAskAbove: { category: Category; amount: number }[];  // ask in this category above the amount (D-056)
  unverifiedMerchants: "block" | "approve" | "allow";
};
```

`evaluatePolicy(policy, spend, candidate, agent?) → { verdict, reasons, rules, agent }`. Every check
runs. Any block means **BLOCK**, otherwise any ask means **NEEDS_APPROVAL**, otherwise **ALLOW**.

| Check | Result |
|---|---|
| Merchant not on a non-empty allow-list | BLOCK |
| Unverified merchant | Per `unverifiedMerchants` |
| Blocked category | BLOCK |
| Amount above `perPurchaseMax` | BLOCK |
| Amount above what's left of the weekly budget | BLOCK |
| Always-ask category | NEEDS_APPROVAL |
| Above the category's threshold | NEEDS_APPROVAL |
| Above `autoApproveLimit` | NEEDS_APPROVAL |

The agent's allowance (D-054) sits on top and can only tighten: paused or outside its categories or
over its weekly allowance → BLOCK; always-ask or above its own auto-pay limit → NEEDS_APPROVAL.

---

## 5. Purchase pipeline (`backend/src/lib/purchase.ts`)

```
requestPurchase({ agent, productId, quantity, userIntent, agentReason, source })
  │
  ├─ 1. Resolve the product server-side       (unknown id → error to the agent, nothing logged)
  │     Channel3 price re-fetched now; if it can't be verified, nothing is bought
  │     amount = price × quantity             (there is no price input)
  ├─ 2. evaluatePolicy(rules + agent's allowance)
  ├─ 3. Child only: kid-safe check            → BLOCK; no rule can turn this off
  ├─ 4. detectInjection(name, description, merchant) → BLOCK; no AI cost
  │     └─ any BLOCK so far → insert BLOCKED, audit, return
  ├─ 5. No saved wallet                       → ALLOW becomes NEEDS_APPROVAL
  ├─ 6. Retry, split and burst guard          → ALLOW becomes NEEDS_APPROVAL
  ├─ 7. assessRisk() via the provider chain, when the verdict is still ALLOW (or RISK_CHECK=always)
  │     high → BLOCK; medium → NEEDS_APPROVAL; every provider failed → medium (fail safe)
  ├─ 8. One PostgreSQL transaction holding a per-user advisory lock:
  │     re-read rules, allowance, spend and recent purchases; apply anything stricter; insert the row
  ├─ 9a. ALLOW → PROCESSING (holds budget) → createVaultedOrder → capture if needed
  │             → PAID | FAILED (PayPal said no) | stays PROCESSING (answer lost, see below)
  └─ 9b. NEEDS_APPROVAL → PENDING_APPROVAL, approvalUrl = APP_URL/approve/:id
```

Each step adds to the purchase's decision timeline (`checks`, D-058). In `reasons`, the reason a purchase
was held comes first, then the checks it passed.

Return value (what the agent and MCP tools receive):

```json
{ "status": "PAID | PENDING_APPROVAL | BLOCKED | FAILED | PROCESSING",
  "transactionId": "tx_…", "title": "…", "merchant": "Bean & Brew", "amount": 18.5, "currency": "USD",
  "reasons": ["…"], "approvalUrl": "https://…/approve/tx_…" }
```

### Velocity guard (`lib/velocity.ts`, D-064)

All of these ask a human; none of them block. Purchases a human approved don't count as splitting or bursts.

| Pattern | Window |
|---|---|
| Same product by the same agent (paid, processing or pending) | 10 minutes |
| Auto-payments to one merchant adding up past the auto-pay limit | 1 hour |
| 5 or more auto-payments by the same agent | 10 minutes |

### Concurrency and idempotency

* Step 8 holds `pg_advisory_xact_lock(hashtext(user_id))`, so two purchases by one user (from any of
  their agents) can't both pass the budget check. Everything inside uses the transaction's own client:
  the lock can queue every pooled connection, so asking the pool for another could deadlock.
* Every PayPal write sends `PayPal-Request-Id`. Reads and writes with an id are retried on network errors and 5xx; other writes never are.
* Webhooks are de-duplicated by event id.

### When PayPal's answer is lost (D-062)

`outcomeUnknown(err)` is true for network errors, timeouts and 5xx: the money may have moved.

* **Auto-pay:** the row stays `PROCESSING`, holding budget. `recoverStuckPayments()` runs every minute and
  re-sends the same request id for rows older than 2 minutes, which returns the original order rather than a new charge.
* It stops at 3 hours, well inside PayPal's idempotency window. Older rows stay `PROCESSING` for a person to review.
* **Approval capture:** stays `PENDING_APPROVAL`, and the owner can retry.
* `FAILED` is only used when PayPal definitely said no, so "nothing was charged" is true.

---

## 6. PayPal integration (`backend/src/lib/paypal.ts`)

Base URL `https://api-m.sandbox.paypal.com` (overridable via `PAYPAL_API_BASE`). 20-second timeout on every call.

| Function | Endpoint | Used by |
|---|---|---|
| `accessToken()` | `POST /v1/oauth2/token` (client credentials, cached until expiry) | all |
| `createSetupToken(returnUrl, cancelUrl, requestId)` | `POST /v3/vault/setup-tokens` | wallet connect |
| `createPaymentToken(setupTokenId)` | `POST /v3/vault/payment-tokens` | wallet return |
| `deletePaymentToken(id)` | `DELETE /v3/vault/payment-tokens/{id}` | wallet disconnect (never for the shared demo wallet) |
| `createOrder(order, attempt, saveWallet?)` | `POST /v2/checkout/orders` (intent CAPTURE) | approval page |
| `createVaultedOrder(order, vaultId)` | `POST /v2/checkout/orders` with `payment_source.paypal.vault_id` | auto-pay |
| `captureOrder(orderId, requestId)` | `POST /v2/checkout/orders/{id}/capture` | approval page, auto-pay |
| `getCapture(captureId)` | `GET /v2/payments/captures/{id}` | Verify with PayPal |
| `refundCapture(captureId, amount, currency, txId)` | `POST /v2/payments/captures/{id}/refund` | ledger |
| `verifyWebhook(headers, rawEvent)` | `POST /v1/notifications/verify-webhook-signature` | webhook route |

Every order carries `reference_id` and `custom_id` = the tx id, the item, and the merchant name in
`description`, so a transaction can be traced in the PayPal sandbox dashboard.

### Wallet connect, option A (primary): save with purchase (D-046)

```
/approve/:id  ["Save my PayPal for auto-pay" ✓] → POST /api/approvals/:id/order {saveWallet:true}
   → Orders v2 with payment_source.paypal.attributes.vault.store_in_vault = ON_SUCCESS
     (+ experience_context.return_url / cancel_url, required when vaulting)
   → buyer approves in the PayPal popup → POST /api/approvals/:id/capture
   → capture response: payment_source.paypal.attributes.vault.id → wallet = CONNECTED
```

Works with the permissions a fresh sandbox app gets (no `vault/payment-tokens` scope needed).

### Wallet connect, option B: Vault v3, "save PayPal without purchase"

Needs the standalone Vault API scope. If PayPal answers `NOT_AUTHORIZED`, `/api/wallet/connect`
returns 409 with a hint to use option A.

```
UI "Connect PayPal" → POST /api/wallet/connect (proxied to the backend)
   → setup token → returns links[rel=approve]
   → browser redirects to PayPal → buyer logs in (sandbox personal account) → approves
   → PayPal redirects to /api/wallet/return?approval_token_id=…
   → POST /v3/vault/payment-tokens {token:{id, type:"SETUP_TOKEN"}} → payment token id
   → wallet = CONNECTED → redirect to "/?wallet=connected"
```

### Webhooks handled

The signature is checked against the raw request body, because re-serializing can break a genuine signature.

| Event | Effect |
|---|---|
| `PAYMENT.CAPTURE.COMPLETED` | Marks a processing or pending purchase PAID |
| `PAYMENT.CAPTURE.DENIED` | Marks it FAILED |
| `PAYMENT.CAPTURE.REFUNDED` | Marks a paid purchase REFUNDED |
| `VAULT.PAYMENT-TOKEN.DELETED` | Disconnects the wallet: the buyer removed consent in PayPal |
| `CUSTOMER.DISPUTE.CREATED` | Pauses the external agent or child that made the purchase |
| Anything else | Audit log only |

The app also updates state from API responses, so it works on localhost, where PayPal can't reach the webhook.

---

## 7. AI components

All AI calls go through `backend/src/lib/llm` (provider-neutral). Providers: **Gemini** (free tier),
**Groq** (free tier), **Claude** (paid, optional). The chain is `LLM_PROVIDER` first, then
`LLM_FALLBACKS` (default: every other provider with a key). A provider that is rate-limited,
down, misconfigured or returns invalid output is skipped and the next one answers; a refusal is
returned as-is.

| Component | Call | Output | Can it change money or rules? |
|---|---|---|---|
| Shopping agent (`lib/agent.ts`) | `llm.chat()` tool-use loop, max 8 iterations | Text, step trace, which AI answered | Only by asking through the pipeline |
| Risk check (`lib/risk.ts`) | `llm.json()` + Zod | `{ level, matchesIntent, reason }` | Can only tighten a decision |
| Rule parser (`lib/rules-parser.ts`) | `llm.json()` + Zod | `Policy` + a short summary | Yes, when the owner submits new rules |
| Ledger questions (`lib/explorer.ts`) | `llm.json()` + Zod | A grid view: filters and a sort | No. It never sees a transaction |
| Rule advisor (`lib/advisor.ts`) | `llm.json()` + Zod, optional | One sentence per suggestion | No. Code picks suggestions, from counts only; the owner applies them |

Structured output per provider: Claude `messages.parse` (constrained decoding); Gemini
`response_format: json_schema` (falls back to `json_object`); Groq `json_object` + schema in the
prompt. Every result is validated with Zod, with one repair retry.

### Agent tools

| Tool | Input | Effect |
|---|---|---|
| `search_products` | `query`, `max_price?`, `category?` | Catalog search (read-only) |
| `get_spending_status` | none | Rules, budget, allowance, wallet state. A child sees only their own allowance |
| `request_purchase` | `product_id`, `quantity`, `reason` | Runs the pipeline. `userIntent` is set by the server from the user's messages, so the agent can't rewrite what was asked |
| `list_recent_transactions` | `limit?` | Ledger read. A child sees only their own |

MCP clients get `search_products`, `get_spending_status`, `request_purchase`, `withdraw_purchase_request`
and `list_transactions`. An MCP client passes the user's request itself, since Allowance can't see that conversation.

Refunds and approvals are **deliberately not** agent tools: those stay human actions.

### Conversation state

Stored server-side per conversation id as provider-neutral `ChatItem[]` (`{v: 2, items}`),
append-only. Each assistant item also keeps the provider's raw message; when the same provider
continues, the raw message is replayed verbatim (Claude thinking blocks, Gemini thought
signatures). After a fallback, items from another provider are rebuilt in the new provider's format.

---

## 8. Attack Lab and demo accounts

**Attack Lab (`lib/redteam.ts`, D-065).** Each attack runs through the real `requestPurchase` in its own
throwaway account, deleted afterwards. Two internal options, which no route or MCP tool passes:

* `simulatePayment`: PayPal is never called, so no run can move money.
* `assessRisk`: on "code" attacks the reviewer is rigged to approve everything, so the code has to hold alone. The "ai" attack uses the real reviewer.

**Demo accounts (`lib/demo.ts`, D-067).** `POST /api/demo/start` creates a user with rules, two agents, a child and
labelled sample history, plus three fresh rows from the real pipeline. It only runs against the PayPal sandbox.
`DEMO_VAULT_ID` optionally gives every demo account one shared sandbox wallet.

---

## 9. HTTP API contracts

Served by the backend (`:4000`). The browser calls the same paths on the frontend, which proxies them.
**Auth:** public, *owner* (session), *member* (owner or child session), *agent* (agent key), *merchant* (`MERCHANT_API_KEY`).

| Method + path | Auth | Body | Response |
|---|---|---|---|
| `GET /health` | public | none | `{ok, service}` |
| `GET /api/ai` | public | none | `{providers, riskCheck}` |
| `GET /api/catalog` | public | none | `{source, merchants, products}` |
| `POST /api/auth/signup` | public | `{email, password}` | `{user}` + cookie |
| `POST /api/auth/login` | public | `{email, password}` (email or a child's username) | `{user, role}` + cookie |
| `POST /api/auth/logout` | public | none | `{ok}` |
| `GET /api/auth/me` | member | none | `{user, role, child}` |
| `GET /api/demo` | public | none | `{available, autoPay}` |
| `POST /api/demo/start` | public | none | `{user, kidLogin, kidPassword, autoPay}` + cookie |
| `GET /api/demo/info` | owner | none | `{demo, kidLogin, kidPassword, autoPay}` |
| `GET /api/lab` | owner | none | `{total}` |
| `POST /api/lab/run` | owner | none | `AttackReport`; one run per 20 seconds |
| `POST /api/chat` | member | `{conversationId, message}` | `{reply, steps, purchases, ai}` |
| `GET /api/kid` | child | none | `{child, transactions}` |
| `POST /api/kid/purchases/:id/withdraw` | child | none | `{transaction}` |
| `GET /api/policy` | owner | none | `{policy, sourceText, summary, spend}` |
| `PUT /api/policy` | owner | `{policy}` | `{policy, summary}` |
| `POST /api/policy/parse` | owner | `{text, apply?}` | `{policy, summary, rules, applied}` |
| `GET /api/policy/suggestions` | owner | none | `{suggestions, explainedBy}` |
| `POST /api/policy/suggestions/:id/apply` | owner | none | `{policy, summary, sourceText}`; 409 if it no longer applies |
| `GET /api/transactions` | owner | none | `{transactions, events, spend, wallet, agents}` |
| `GET /api/transactions/explorer` | owner | none | `{transactions}` |
| `POST /api/transactions/ask` | owner | `{question}` | `{view, answeredBy}` |
| `POST /api/transactions/reconcile` | owner | none | `{rows, checked, mismatches}` |
| `POST /api/transactions/:id/refund` | owner | none | `{transaction}` |
| `GET /api/approvals/:id` | owner | none | `{transaction, product}` |
| `POST /api/approvals/:id/order` | owner | `{saveWallet?}` | `{orderId}` |
| `POST /api/approvals/:id/capture` | owner | `{orderId}` | `{transaction}` |
| `POST /api/approvals/:id/reject` | owner | none | `{transaction}` |
| `GET /api/wallet` | owner | none | `{status, payerEmail}` |
| `POST /api/wallet/connect` | owner | none | `{approveUrl}` |
| `GET /api/wallet/return` | owner | PayPal redirect | Redirect to the dashboard |
| `DELETE /api/wallet` | owner | none | `{status, payerEmail}` |
| `GET /api/agents` | owner | none | `{agents}` |
| `GET /api/agents/connect` | owner | none | `{mcpUrl, apiUrl}` |
| `POST /api/agents` | owner | Name and limits | `{agent, apiKey}`; the key is shown once |
| `POST /api/agents/children` | owner | Name, limits, `loginName`, `password` | `{agent}` |
| `PATCH /api/agents/:id` | owner | Fields to change, `status?`, `password?` | `{agent}` |
| `DELETE /api/agents/:id` | owner | none | `{ok}` |
| `GET /api/checkout/:quoteId` | member | none | `{product, merchant, agents}` |
| `POST /api/checkout/:quoteId` | member | `{agentId, quantity, intent}` | `{result, transaction}` |
| `GET /api/store/products` | public | none | `{store, products}` |
| `POST /api/store/checkout` | public | `{productId, quantity}` | `{quoteId, quantity, checkoutUrl}` |
| `GET /api/store/orders/:quoteId` | public | none | `{store, order}`, with no buyer details |
| `POST /api/merchant/quotes` | merchant | See `openapi.yaml` | The quote, with `quoteId` |
| `GET /api/merchant/quotes/:id` | merchant | none | The quote |
| `POST /api/agent/search` | agent | `{query, maxPrice?, category?}` | `{products}` |
| `GET /api/agent/status` | agent | none | Spending status |
| `POST /api/agent/purchase` | agent | `{productId, quantity, intent, reason}` | Pipeline result |
| `POST /api/agent/purchases/:id/withdraw` | agent | none | `{id, status}` |
| `GET /api/agent/transactions` | agent | none | `{transactions}` |
| `POST /mcp` | agent | MCP JSON-RPC | MCP response |
| `POST /api/paypal/webhook` | PayPal signature | PayPal event | `200`; `401` if the signature fails |

---

## 10. Error handling

* PayPal errors → `PayPalError {status, name, debugId, details}`. A definite refusal marks the purchase `FAILED`, with the
  `debug_id` in the audit log (PayPal support asks for this id). An unknown outcome doesn't: see §5.
* AI errors → `LlmError`. Chat returns a friendly message, and the risk check fails safe to `medium` (human approval).
* All money-moving routes validate input with Zod and re-check the purchase's status before acting
  (you can't capture a rejected purchase or refund an unpaid one).

## 11. Testing

`npm test` needs no keys. It uses its own database (`TEST_DATABASE_URL`, default: the Docker one) and a fake PayPal, and never loads `.env`.

| File | Covers |
|---|---|
| `test/unit.test.ts` | Policy engine, injection screen, kid-safe check, velocity guard, rule advisor, reconciliation |
| `test/redteam.test.ts` | Every Attack Lab scenario holds, and leaves nothing behind |
| `test/api.test.ts` | Real HTTP and database: lost responses, retries, permissions, webhooks, demo accounts |

The fake PayPal charges once per request id, and can drop the connection before or after charging, return an HTML 502, or decline.

## 12. Security notes

* Secrets only in `.env` (git-ignored); `.env.example` is the template.
* Dashboard APIs require a session cookie (HttpOnly, SameSite=Lax; only its SHA-256 is stored).
  Passwords are scrypt-hashed; login is rate-limited. Every query is scoped to the session's user.
* `/api/agent/*` and `/mcp` require `Authorization: Bearer <that agent's own key>` (only its SHA-256 is
  stored; revoking clears it). An agent acts only for its own user and only sees its own purchases.
* A child's session can shop and see their own purchases. Rules, wallet, approvals and refunds answer 403.
* Approval pages need the owner to be logged in, so an approval link is safe to hand to an agent.
* Webhook signatures are verified with PayPal before any state change.
* The agent never sees PayPal credentials or vault ids; it only sees product ids and outcomes.
* Prices, merchant trust, and the chat user's intent are server-side facts the model can't override.
* The demo refuses to run unless the PayPal base is the sandbox, because its optional wallet is shared.
* The injection screen is pattern matching, not a guarantee. The limits above are what bound an injected agent.
