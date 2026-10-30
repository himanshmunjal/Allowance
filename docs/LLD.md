# Allowance: Low-Level Design (LLD)

> High-level picture: [`architecture.png`](../architecture.png) (source: [`architecture.dot`](architecture.dot)).
> Why each choice was made: [`DECISION.md`](../DECISION.md). Build log: [`FLOW.md`](../FLOW.md).

---

## 1. Goal and non-goals

**Goal.** Let an AI agent spend a user's money through PayPal while the user stays in control.
Every spend, whether it comes from the built-in chat agent or from an external agent over MCP,
passes through **one** server-side pipeline that applies deterministic rules, then an AI intent
check, then one of three outcomes:

| Outcome | When | What happens in PayPal |
|---|---|---|
| **Auto-paid** | within every rule, amount ≤ auto-approve limit, low risk, wallet connected | Order created with the vaulted PayPal token and captured server-side, with no popup |
| **Needs approval** | above the auto-approve limit, medium risk, approval-required category, or no wallet connected | Pending record; user approves on `/approve/:id` with PayPal Smart Buttons |
| **Blocked** | merchant not allow-listed, category blocked, over hard cap, over weekly budget, high risk | Nothing touches PayPal; logged with the reason |

**Non-goals (hackathon scope).** Multi-user auth, real merchants receiving funds (all sandbox
payments settle to one sandbox merchant account), and shipping/fulfilment.

---

## 2. Repository layout

Two deployable apps in one repo (npm workspaces). The browser only talks to the frontend; the
frontend proxies `/api/*` to the backend, so both look like one origin.

```
browser ──► frontend (Next.js, :3000) ──/api/*──► backend (Hono, :4000) ──► PayPal / AI providers / PostgreSQL
MCP client ─────────────────────────────────────► backend /api/agent/*
```

```
/
├─ frontend/                          Next.js 16 App Router (UI only, no server logic)
│  ├─ app/
│  │  ├─ page.tsx                     Dashboard: chat | rules + wallet | ledger
│  │  ├─ approve/[id]/                Human approval page (PayPal JS SDK v6 button)
│  │  ├─ components/                  Chat, Header, RulesPanel, Ledger, Dashboard, format.ts
│  │  ├─ layout.tsx, globals.css
│  ├─ next.config.ts                  rewrites /api/:path* → BACKEND_URL/api/:path*
│  └─ tsconfig.json                   alias @shared/* → ../backend/src/shared/* (type-only)
├─ backend/                           Node 22 + Hono, ESM, bundled by tsup → dist/server.js
│  ├─ src/
│  │  ├─ server.ts                    entry: @hono/node-server on PORT (4000)
│  │  ├─ app.ts                       mounts routers, CORS, request log, error handler
│  │  ├─ http.ts                      error → HTTP mapping, agent bearer-key middleware
│  │  ├─ routes/
│  │  │  ├─ chat.ts                   POST /api/chat
│  │  │  ├─ policy.ts                 GET/PUT /api/policy, POST /api/policy/parse
│  │  │  ├─ ledger.ts                 GET /api/transactions, POST /api/transactions/:id/refund
│  │  │  ├─ approvals.ts              GET /api/approvals/:id, POST …/order, …/capture, …/reject
│  │  │  ├─ wallet.ts                 GET/DELETE /api/wallet, POST /connect, GET /return
│  │  │  ├─ webhook.ts                POST /api/paypal/webhook
│  │  │  ├─ agent.ts                  /api/agent/* (bearer key) for MCP clients
│  │  │  └─ meta.ts                   GET /api/catalog, GET /api/ai
│  │  ├─ lib/
│  │  │  ├─ config.ts                 env access + validation
│  │  │  ├─ db.ts                     PostgreSQL pool, migrations, row mappers, append-only audit log
│  │  │  ├─ catalog.ts                demo merchants + products, search
│  │  │  ├─ policy.ts                 Policy schema, defaults, evaluate(), spend summary
│  │  │  ├─ injection.ts              deterministic prompt-injection screen for listings
│  │  │  ├─ paypal.ts                 PayPal REST client (OAuth, orders, vault, refunds, webhooks)
│  │  │  ├─ wallet.ts                 vaulted wallet state (vault id never leaves the server)
│  │  │  ├─ purchase.ts               THE purchase pipeline (only code path that spends money)
│  │  │  ├─ agent.ts                  tool-use loop for the chat agent (any provider)
│  │  │  ├─ risk.ts                   AI intent / risk check (structured output)
│  │  │  ├─ rules-parser.ts           English → Policy (structured output)
│  │  │  └─ llm/                      provider-neutral AI layer
│  │  │     ├─ types.ts               ChatItem / ToolSpec / LlmProvider / LlmError
│  │  │     ├─ anthropic.ts           Claude (Anthropic SDK)
│  │  │     ├─ openai-compat.ts       Gemini + Groq (OpenAI-compatible endpoints, `openai` SDK)
│  │  │     └─ index.ts               provider chain + automatic fallback
│  │  └─ shared/types.ts              API types shared with the frontend (no runtime code)
│  ├─ mcp/server.ts                   stdio MCP server → /api/agent/*
│  ├─ scripts/check-ai.ts             tests every configured AI key (JSON + tool call)
├─ docs/                              LLD.md, architecture.dot
└─ architecture.png, DECISION.md, FLOW.md, README.md, LICENSE, render.yaml, package.json (workspaces)
```

---

## 3. Data model (PostgreSQL, D-055)

> **Updated by D-053 – D-055.** The app is multi-user and runs on PostgreSQL. Tables:
> `users`, `sessions` (SHA-256 of the cookie token), `policies` and `wallets` (one row per user),
> `agents` (per-agent allowance + SHA-256 of its API key), `transactions` (+ `user_id`, `agent_id`,
> `agent_name`; money is `NUMERIC(12,2)`, reasons are `JSONB`), `audit_events` (+ `user_id`),
> `conversations` (primary key `(user_id, id)`), `quotes`, `webhook_events`. The schema lives in
> `backend/src/lib/db.ts` (`migrate`). The SQLite sketch below is the original single-user design.

### Original single-user schema (SQLite, superseded)

```sql
-- singleton rows keyed by 'default' (single-user demo)
CREATE TABLE policy (
  id          TEXT PRIMARY KEY,           -- 'default'
  json        TEXT NOT NULL,              -- Policy (see §4)
  source_text TEXT,                       -- last English description the user typed
  updated_at  TEXT NOT NULL
);

CREATE TABLE wallet (
  id               TEXT PRIMARY KEY,      -- 'default'
  status           TEXT NOT NULL,         -- 'PENDING' | 'CONNECTED'
  setup_token_id   TEXT,                  -- Vault v3 setup token (while PENDING)
  payment_token_id TEXT,                  -- Vault v3 payment token (vault_id) once CONNECTED
  customer_id      TEXT,
  payer_email      TEXT,
  updated_at       TEXT NOT NULL
);

CREATE TABLE transactions (
  id               TEXT PRIMARY KEY,      -- 'tx_' + random
  source           TEXT NOT NULL,         -- 'chat' | 'mcp'
  status           TEXT NOT NULL,         -- PROCESSING | PAID | PENDING_APPROVAL | BLOCKED | REJECTED | REFUNDED | FAILED
  merchant_id      TEXT NOT NULL,
  product_id       TEXT NOT NULL,
  title            TEXT NOT NULL,
  quantity         INTEGER NOT NULL,
  unit_price       REAL NOT NULL,         -- from catalog, never from the agent
  amount           REAL NOT NULL,
  currency         TEXT NOT NULL,
  user_intent      TEXT NOT NULL,         -- what the human originally asked for
  agent_reason     TEXT NOT NULL,         -- why the agent chose this item
  decision_reasons TEXT NOT NULL,         -- JSON string[]: rule + risk outcomes
  risk_level       TEXT,                  -- low | medium | high
  risk_reason      TEXT,
  paypal_order_id  TEXT,
  paypal_capture_id TEXT,
  paypal_refund_id TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE audit_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id      TEXT,                        -- nullable (policy / wallet events)
  type       TEXT NOT NULL,               -- e.g. POLICY_UPDATED, PURCHASE_BLOCKED, PAYPAL_CAPTURED, WEBHOOK_RECEIVED
  message    TEXT NOT NULL,
  data       TEXT,                        -- JSON
  created_at TEXT NOT NULL
);

CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,            -- client-generated uuid
  messages   TEXT NOT NULL,               -- JSON Anthropic MessageParam[] (append-only)
  updated_at TEXT NOT NULL
);

CREATE TABLE webhook_events (             -- de-duplication of PayPal retries
  id          TEXT PRIMARY KEY,           -- PayPal event id
  received_at TEXT NOT NULL
);
```

---

## 4. Policy

```ts
type Policy = {
  currency: "USD";
  weeklyBudget: number;              // rolling 7 days; PAID + PENDING_APPROVAL count
  autoApproveLimit: number;          // ≤ this → may auto-pay
  perPurchaseMax: number;            // hard cap, above → BLOCKED
  allowedMerchants: string[];        // merchant ids; empty = all verified merchants
  blockedCategories: string[];       // → BLOCKED
  approvalCategories: string[];      // always → NEEDS_APPROVAL
  requireApprovalForUnverified: boolean;
};
```

`evaluatePolicy(policy, spend, candidate) → { verdict: "ALLOW" | "NEEDS_APPROVAL" | "BLOCK", reasons: string[] }`

Evaluation order (first BLOCK wins, otherwise the strongest verdict wins):

1. merchant not in allow-list → **BLOCK**
2. category in `blockedCategories` → **BLOCK**
3. `amount > perPurchaseMax` → **BLOCK**
4. `spentThisWeek + pending + amount > weeklyBudget` → **BLOCK**
5. category in `approvalCategories` → NEEDS_APPROVAL
6. merchant unverified and `requireApprovalForUnverified` → NEEDS_APPROVAL
7. `amount > autoApproveLimit` → NEEDS_APPROVAL
8. otherwise → ALLOW

---

## 5. Purchase pipeline (`backend/src/lib/purchase.ts`)

```
requestPurchase({ productId, quantity, userIntent, agentReason, source })
  │
  ├─ 1. Resolve product from catalog            (unknown id → error to agent, nothing logged)
  │     amount = catalog.price × quantity       (agent cannot set prices)
  ├─ 2. spend = spendSummary(last 7 days)
  ├─ 3. rules = evaluatePolicy(policy, spend, candidate)
  │     + detectInjection(listing) → flagged = BLOCK            (no AI cost)
  │     └─ BLOCK → insert tx BLOCKED, audit, return
  ├─ 4. wallet not CONNECTED → upgrade ALLOW to NEEDS_APPROVAL
  ├─ 5. risk = assessRisk(...) via provider chain (structured JSON)
  │     runs when verdict is ALLOW (or always, if RISK_CHECK=always)
  │     high   → BLOCKED
  │     medium → upgrade verdict to NEEDS_APPROVAL
  │     (every provider failed → medium: fail safe, a human decides)
  ├─ 6. budget + agent-allowance re-check + insert inside one PostgreSQL transaction (per-user advisory lock)
  ├─ 7a. ALLOW → tx PROCESSING (reserves budget) → paypal.createVaultedOrder(vault_id)
  │            → capture if not COMPLETED → tx PAID (order id, capture id) | FAILED (error)
  └─ 7b. NEEDS_APPROVAL → tx PENDING_APPROVAL, return approvalUrl = APP_URL/approve/:id
```

Return value (also what the agent tool and MCP tool receive):

```json
{ "status": "PAID | PENDING_APPROVAL | BLOCKED | FAILED",
  "transactionId": "tx_…", "amount": 18.5, "merchant": "Bean & Brew",
  "reasons": ["Within $25 auto-approve limit", "Risk: low (matches request)"],
  "approvalUrl": "https://…/approve/tx_…" }
```

### Concurrency and idempotency

* The "check budget → insert row" step runs in one PostgreSQL transaction holding
  `pg_advisory_xact_lock(hashtext(user_id))`, so two concurrent purchases by the same user (from
  any of their agents) cannot both pass the budget or allowance check.
* Every PayPal POST sends `PayPal-Request-Id = <tx id>-<operation>`, so retries never double-charge.
* Webhooks are de-duplicated by event id (`webhook_events`).

---

## 6. PayPal integration (`backend/src/lib/paypal.ts`)

Base URL `https://api-m.sandbox.paypal.com` (overridable via `PAYPAL_API_BASE`).

| Function | Endpoint | Used by |
|---|---|---|
| `getAccessToken()` | `POST /v1/oauth2/token` (client credentials, cached until expiry) | all |
| `createSetupToken(returnUrl, cancelUrl)` | `POST /v3/vault/setup-tokens` (payment_source.paypal, usage_type MERCHANT) | wallet connect |
| `createPaymentToken(setupTokenId)` | `POST /v3/vault/payment-tokens` | wallet return |
| `deletePaymentToken(id)` | `DELETE /v3/vault/payment-tokens/{id}` | wallet disconnect |
| `createOrder(tx)` | `POST /v2/checkout/orders` (intent CAPTURE) | approval page |
| `createVaultedOrder(tx, vaultId)` | `POST /v2/checkout/orders` with `payment_source.paypal.vault_id` | auto-pay |
| `captureOrder(orderId)` | `POST /v2/checkout/orders/{id}/capture` | approval page, auto-pay fallback |
| `refundCapture(captureId, amount)` | `POST /v2/payments/captures/{id}/refund` | ledger |
| `verifyWebhook(headers, body)` | `POST /v1/notifications/verify-webhook-signature` | webhook route |

Every order carries `custom_id = tx id`, `invoice_id = tx id`, item name, and merchant name in
`description`, so the transaction is traceable in the PayPal sandbox dashboard.

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
UI "Connect PayPal wallet" → POST /api/wallet/connect (proxied to the backend)
   → setup-token (status PAYER_ACTION_REQUIRED) → returns links[rel=approve]
   → browser redirects to PayPal → buyer logs in (sandbox personal account) → approves
   → PayPal redirects to /api/wallet/return?approval_token_id=…
   → POST /v3/vault/payment-tokens {token:{id, type:"SETUP_TOKEN"}} → payment token id
   → wallet = CONNECTED → redirect to "/?wallet=connected"
```

### Webhooks handled

`PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`,
`CHECKOUT.ORDER.APPROVED`, `VAULT.PAYMENT-TOKEN.CREATED`. Status changes are applied idempotently.
The app also updates state synchronously from API responses, so it works on localhost where
PayPal cannot reach the webhook.

---

## 7. AI components

All AI calls go through `backend/src/lib/llm` (provider-neutral). Providers: **Gemini** (free tier),
**Groq** (free tier), **Claude** (paid, optional). The chain is `LLM_PROVIDER` first, then
`LLM_FALLBACKS` (default: every other provider with a key). A provider that is rate-limited,
down, misconfigured or returns invalid output is skipped and the next one answers; a refusal is
returned as-is.

| Component | Call | Output |
|---|---|---|
| Shopping agent (`lib/agent.ts`) | `llm.chat()` manual tool-use loop, max 8 iterations; sticks to the provider that started the turn | assistant text + step trace + which AI answered |
| Risk check (`lib/risk.ts`) | `llm.json()` + Zod schema | `{ level, matchesIntent, reason }` |
| Rule parser (`lib/rules-parser.ts`) | `llm.json()` + Zod schema | `Policy` + a short summary |

Structured output per provider: Claude `messages.parse` (constrained decoding); Gemini
`response_format: json_schema` (falls back to `json_object`); Groq `json_object` + schema in the
prompt. Every result is validated with Zod, with one repair retry.

Calls per chat message: about 2–5 agent steps, plus 1 risk check only for purchases that would
auto-pay (`RISK_CHECK=autopay`).

### Agent tools

| Tool | Input | Effect |
|---|---|---|
| `search_products` | `query`, `max_price?`, `category?` | catalog search (read-only) |
| `get_spending_status` | none | policy, budget used and remaining, wallet state |
| `request_purchase` | `product_id`, `quantity`, `reason` | runs the purchase pipeline; `userIntent` is set by the server to the latest user message, so the agent can't rewrite what the user asked |
| `list_recent_transactions` | `limit?` | ledger read |

Refunds are **deliberately not** an agent tool: undoing money movement stays a human action.

### Conversation state

Stored server-side per conversation id as provider-neutral `ChatItem[]` (`{v: 2, items}`),
append-only. Each assistant item also keeps the provider's raw message; when the same provider
continues, the raw message is replayed verbatim (Claude thinking blocks, Gemini thought
signatures). After a fallback, items from another provider are rebuilt in the new provider's format.

---

## 8. HTTP API contracts

Served by the backend (`:4000`). The browser calls the same paths on the frontend, which proxies them.

| Method + path | Body | Response |
|---|---|---|
| `GET /health` | none | `{ok: true}` (Render health check) |
| `GET /api/ai` | none | `{providers:[{id,label,model}], riskCheck}` |
| `GET /api/catalog` | none | `{merchants, products}` |
| `POST /api/chat` | `{conversationId, message}` | `{reply, steps:[{tool,input,output}], purchases:[...], ai}` |
| `GET /api/policy` | none | `{policy, sourceText}` |
| `PUT /api/policy` | `{policy}` | `{policy}` |
| `POST /api/policy/parse` | `{text, apply?:boolean}` | `{policy, summary}` |
| `GET /api/transactions` | none | `{transactions, events, spend, wallet}` |
| `POST /api/transactions/:id/refund` | none | `{transaction}` |
| `GET /api/approvals/:id` | none | `{transaction}` |
| `POST /api/approvals/:id/order` | none | `{orderId}` |
| `POST /api/approvals/:id/capture` | `{orderId}` | `{transaction}` |
| `POST /api/approvals/:id/reject` | none | `{transaction}` |
| `GET /api/wallet` | none | `{status, payerEmail}` |
| `POST /api/wallet/connect` | none | `{approveUrl}` |
| `DELETE /api/wallet` | none | `{status}` |
| `POST /api/paypal/webhook` | PayPal event | `200` |
| `POST /api/agent/search` | `{query, maxPrice?, category?}` | `{products}` (bearer) |
| `GET /api/agent/status` | none | spend status (bearer) |
| `POST /api/agent/purchase` | `{productId, quantity, intent, reason}` | pipeline result (bearer) |
| `GET /api/agent/transactions` | none | ledger (bearer) |

---

## 9. Error handling

* PayPal errors → `PayPalError {status, name, debugId, details}`. The tx is marked FAILED with the
  `debug_id` stored in the audit log (PayPal support asks for this id).
* Anthropic errors → typed SDK classes; chat returns a friendly message, and the risk check
  fails safe to `medium` (human approval).
* All money-moving routes validate input with Zod and re-check the tx status before acting
  (e.g. you can't capture a REJECTED tx, and you can't refund one that isn't PAID).

## 10. Security notes

* Secrets only in `.env` (git-ignored); `.env.example` is the template.
* Dashboard APIs require a session cookie (HttpOnly, SameSite=Lax; only its SHA-256 is stored).
  Passwords are scrypt-hashed; login is rate-limited. Every query is scoped to the session's user.
* `/api/agent/*` requires `Authorization: Bearer <that agent's own key>` (only its SHA-256 is
  stored; revoking clears it). An agent acts only for its own user and only sees its own purchases.
* Approval pages need the owner to be logged in, so an approval link is safe to hand to an agent.
* Webhook signatures verified with PayPal before any state change.
* The agent never sees PayPal credentials or vault ids; it only sees product ids and outcomes.
* Prices, merchant trust, and user intent are server-side facts the model cannot override.
