# FLOW.md: Build Flow

The complete, ordered log of how this project was built: what was done in each step, which
files changed, and how to run things at that point. Decisions referenced as `D-xxx` are explained
in [DECISION.md](DECISION.md).

---

## Phase 0: Design (before writing app code)

### Step 0.1 · Repository bootstrap
* `git init` on branch `main`.
* `.gitignore`: ignores `node_modules`, `.next`, `.env*` (except `.env.example`), and the SQLite db.
* `LICENSE`: MIT (the hackathon requires an open-source license visible in the repo).

### Step 0.2 · Architecture diagram
* Wrote `docs/architecture.dot` (Graphviz) and rendered `architecture.png` (D-016).
* First render used a left-to-right layout; edges crossed heavily and it was hard to read.
  **Changed** to a top-to-bottom layered layout (Users → Entry points → AI layer → Trust core →
  Payments & storage → External services). Re-render:
  `dot -Tpng -Gdpi=150 docs/architecture.dot -o architecture.png`

### Step 0.3 · Low-level design
* Wrote `docs/LLD.md`: repo layout, SQLite schema, policy evaluation order, purchase pipeline,
  PayPal endpoint map, Vault wallet-connect flow, AI components and agent tools, HTTP contracts,
  error handling, security notes.

### Step 0.4 · Decision log + this file
* `DECISION.md` seeded with D-001 … D-016.

---

## Phase 1: Scaffold

### Step 1.1 · Next.js app
* `create-next-app@16` (TypeScript, Tailwind v4, ESLint, App Router, Turbopack) generated in a
  scratch folder (the repo wasn't empty) and copied in. Merged its `.gitignore` entries into ours.
* Discovered Next 16.4 enables **Cache Components** by default. Read the bundled docs in
  `node_modules/next/dist/docs/` → led to **D-017** (`connection()` before SQLite reads).

### Step 1.2 · Dependencies
* Runtime: `@anthropic-ai/sdk` (1.3), `zod` (4), `better-sqlite3`, `@paypal/react-paypal-js`,
  `@modelcontextprotocol/sdk`.
* Dev: `@types/better-sqlite3`, `tsx` (runs the MCP server without a build step).

---

## Phase 2: Server core (`lib/`)

Built bottom-up so each layer only depends on the ones before it:

| Step | File | What |
|---|---|---|
| 2.1 | `lib/config.ts` | Lazy env access with clear "missing variable" errors, so `next build` works without secrets |
| 2.2 | `lib/types.ts` | Shared domain types (Transaction, PurchaseResult, ...) |
| 2.3 | `lib/db.ts` | SQLite connection (WAL), schema migration on first use, transaction + audit helpers (D-024) |
| 2.4 | `lib/catalog.ts` | 7 demo merchants / 23 products, incl. an **unverified seller with a prompt-injection listing** and a **gambling** merchant for the "blocked" demo |
| 2.5 | `lib/policy.ts` | Zod `PolicySchema`, defaults, rolling 7-day spend summary, `evaluatePolicy()` |
| 2.6 | `lib/paypal.ts` | REST client: OAuth, Orders v2, Vault v3, refunds, webhook verification (D-018) |
| 2.7 | `lib/ai.ts` | Anthropic client + refusal fallback params (D-019) |
| 2.8 | `lib/risk.ts` | AI intent/risk check with structured output; fails safe to "needs approval" |
| 2.9 | `lib/rules-parser.ts` | English → Policy with structured output |
| 2.10 | `lib/wallet.ts` | Vaulted-wallet state; the vault id never leaves the server |
| 2.11 | `lib/purchase.ts` | **The purchase pipeline**: rules → AI risk → budget re-check in a DB transaction → auto-pay / approval / block; approval capture, reject, refund |
| 2.12 | `lib/agent.ts` | Claude tool-use loop, 4 tools, step trace, append-only conversation storage |

**Change during this phase:** auto-pay rows were first inserted as `PAID` before capture; changed to
a new `PROCESSING` status (**D-020**).

Type-check after this phase: `npx tsc --noEmit` → clean (after fixing a readonly `betas` tuple and
generating Next route types with `npx next typegen`).

---

## Phase 3: HTTP API (`app/api/`)

* `lib/http.ts`: one error→HTTP mapper (Zod 400, PayPal 400/502 with `paypalDebugId`, Claude
  auth/rate-limit messages) + timing-safe bearer check for the agent API.
* Routes (18 handlers): `chat`, `policy`, `policy/parse`, `catalog`, `transactions`,
  `transactions/[id]/refund`, `approvals/[id]` (+ `order`, `capture`, `reject`), `wallet`
  (+ `connect`, `return`), `paypal/webhook`, `agent/search|status|purchase|transactions`.
* Every DB-reading GET calls `await connection()` (D-017). Webhook rejects unsigned events (D-023).
* `.env.example` (committed template, documented) and `.env` (local, git-ignored, with a freshly
  generated `AGENT_API_KEY`).

---

## Phase 4: UI (`app/`)

| Step | File | What |
|---|---|---|
| 4.1 | `app/globals.css` | Semantic color tokens (`bg-panel`, `text-muted`, `bg-ok-soft`…) with automatic dark mode |
| 4.2 | `app/layout.tsx` | Title/description metadata |
| 4.3 | `app/components/format.ts` | Money/time formatting, status badges, `api()` fetch helper |
| 4.4 | `app/components/Chat.tsx` | Agent chat: suggestion chips, **tool-call trace cards**, purchase outcome cards with approve links, tiny safe markdown |
| 4.5 | `app/components/Header.tsx` | Weekly budget meter (spent / awaiting approval) + PayPal wallet connect / disconnect |
| 4.6 | `app/components/RulesPanel.tsx` | Plain-English rules → "Update rules with AI" → policy chips |
| 4.7 | `app/components/Ledger.tsx` | Live purchases (expand for "you asked / agent's reason / decision / PayPal ids"), refund + approve actions, audit-trail tab |
| 4.8 | `app/components/Dashboard.tsx`, `app/page.tsx` | Layout + 3 s polling (D-011) |
| 4.9 | `app/approve/[id]/` | Approval page with **PayPal JS SDK v6** button (D-025) and reject |

Checks: `tsc` clean → ESLint flagged setState-in-effect → fixed (**D-027**).

---

## Phase 5: Production build + smoke tests

* `npm run build` **failed** on `crypto.randomUUID()` during prerender → fixed (**D-028**).
* Turbopack warned that `db.ts`'s dynamic path traced the whole project → added a
  `turbopackIgnore` hint.
* Build logged a `HANGING_PROMISE_REJECTION` swallowed by our error wrapper → fixed (**D-029**).
* Final build: clean. `/` and `/api/catalog` static, all DB routes dynamic, `/approve/[id]` partial prerender.
* Smoke tests against `npm start` (no PayPal/Claude keys yet, which exercises the safety paths):

| Test | Expected | Result |
|---|---|---|
| Agent API without bearer key | 401 | ✅ |
| Casino credits | BLOCKED (category), no AI/PayPal call | ✅ |
| Injection listing × 10 | BLOCKED (unverified seller + $100 cap) | ✅ |
| Earbuds $79 | PENDING_APPROVAL (electronics + over $25) | ✅ |
| Coffee $18.50 with no Claude key | AI check fails safe → PENDING_APPROVAL | ✅ |
| 3 × pour-over kit $192 | BLOCKED (cap + budget, pending counted) | ✅ |
| Reject twice / refund unpaid | 2nd call refused (400) | ✅ |
| Unsigned webhook | 401 | ✅ |
| `/approve/:id` page | 200 | ✅ |

* Test database deleted afterwards so the first real run starts clean.

---

## Phase 6: MCP server

* `mcp/server.mts`: 4 tools (`search_products`, `get_spending_status`, `request_purchase`,
  `list_transactions`) → `/api/agent/*` with `AGENT_API_KEY`; loads `.env` automatically.
* First run failed (top-level await under CommonJS) → renamed to `.mts` (**D-030**).
* Verified with a raw JSON-RPC session: `initialize` → `tools/list` (4 tools) → `tools/call
  request_purchase` casino credits → **BLOCKED** by the same pipeline.
* `npm run mcp` script added; `package.json` gets description, license, `engines.node >= 22.12`.

---

## Phase 7: Docs and deploy

* `README.md`: pitch, demo flow, **PayPal technology table**, **AI tools table** (both required by
  the hackathon), local setup incl. PayPal sandbox steps, env table, Claude Desktop MCP config,
  deploy notes.
* `render.yaml` Blueprint (**D-031**).
* `data/.gitkeep` so the database folder exists in fresh clones (the db file itself is ignored).

---

## Phase 8: Free AI providers (Gemini + Groq), shift in approach (D-032)

Trigger: the builder is a student without a paid AI budget.

| Step | What |
|---|---|
| 8.1 | Researched the current free tiers: Gemini free tier is Flash-only with small, changing quotas; Groq lists tool-use models (`openai/gpt-oss-120b`, Llama, Qwen…). Confirmed model ids on the official model pages; confirmed Gemini's OpenAI-compatible base URL |
| 8.2 | `npm install openai` (official SDK, used for both OpenAI-compatible endpoints) |
| 8.3 | `lib/llm/types.ts`: neutral `ChatItem`, `ToolSpec`, `LlmProvider`, `LlmError` |
| 8.4 | `lib/llm/anthropic.ts`: the old Claude code moved behind the interface (raw content replayed for thinking blocks) |
| 8.5 | `lib/llm/openai-compat.ts`: Gemini + Groq: tools, tool-call replay (thought signatures), JSON with schema → plain-JSON fallback → Zod validation + repair retry, error classification |
| 8.6 | `lib/llm/index.ts`: provider chain + automatic fallback (D-034) |
| 8.7 | `lib/config.ts`: `GEMINI_*`, `GROQ_*`, `LLM_PROVIDER`, `LLM_FALLBACKS`, `RISK_CHECK`; Anthropic key now optional. Deleted `lib/ai.ts` |
| 8.8 | `lib/risk.ts`, `lib/rules-parser.ts`, `lib/agent.ts` ported to `llm.json()` / `llm.chat()`; conversations stored as `{v: 2, items}` |
| 8.9 | `lib/injection.ts` + pipeline reorder in `lib/purchase.ts` (D-035, D-036) |
| 8.10 | `/api/ai` + chat header ("Gemini (gemini-3.8-flash) · fallback: Groq") + "answered by …" under each reply |
| 8.11 | `scripts/check-ai.mts` → `npm run check-ai` (D-037) |
| 8.12 | `.env` / `.env.example` / `render.yaml` / README / LLD updated |

Issues found and fixed in this phase:
* `tsc` rejected the `.ts` extension in the script's import → extensionless import.
* Gemini returns **400** (not 401) for a bad key → classified as an auth error for a clear message.
* A stale `next-server` process from an earlier test kept port 3000, so tests hit the old build.
  Stopped it by port (`lsof -ti tcp:3000 | xargs kill`) and re-ran.

Verification (invalid keys on purpose, so real network calls to both providers):

| Test | Result |
|---|---|
| `npm run check-ai` with no keys | Clear "no AI provider configured" message ✅ |
| `npm run check-ai` with fake Gemini + Groq keys | Both reached over the network, each reports "API key is invalid" ✅ |
| `/api/ai` | `Gemini (gemini-3.8-flash) → Groq (openai/gpt-oss-120b)`, `riskCheck: autopay` ✅ |
| Chat with both keys bad | Log shows Gemini failed → tried Groq → clean error to the UI ✅ |
| Injection listing (quantity 1, so the cap rule doesn't fire) | BLOCKED by the injection screen with 4 signals, no AI call ✅ |
| $79 earbuds | PENDING_APPROVAL, "AI risk check skipped: you are reviewing this purchase yourself" ✅ |
| `tsc`, ESLint, `next build` | clean ✅ |

---

## Phase 9: Restructure into `frontend/` + `backend/` (D-038 … D-043)

Trigger: the builder asked for a clean two-folder structure. The server was already stopped
(confirmed nothing on ports 3000/4000).

| Step | What |
|---|---|
| 9.1 | Moved UI (`app/` pages + components, `public/`, Next config, ESLint, tsconfig, `AGENTS.md`) → `frontend/`. Deleted the Next API routes (`app/api/`), which were re-implemented in the backend |
| 9.2 | Moved `lib/` → `backend/src/lib/`, `mcp/` → `backend/mcp/`, `scripts/` → `backend/scripts/`, `data/` → `backend/data/`, `.env*` → `backend/` |
| 9.3 | `.mts` → `.ts` (backend is `"type": "module"`, D-043). `lib/types.ts` → `backend/src/shared/types.ts`; added shared `Policy`/`Category` types (D-041) |
| 9.4 | Root `package.json` with npm workspaces + `concurrently`; `backend/package.json` (hono, @hono/node-server, AI SDKs, zod, better-sqlite3; tsup, tsx); `frontend/package.json` (next, react, PayPal React SDK). Fresh `npm install` |
| 9.5 | Backend server: `src/http.ts` (error mapping, bearer-key middleware, quiet request log), `src/routes/*.ts` (8 routers), `src/app.ts`, `src/server.ts`, `tsup.config.ts`, `tsconfig.json` |
| 9.6 | Frontend: imports switched to `@shared/types`; `next.config.ts` proxy (D-040); `frontend/.env.example` + `.env.local` |
| 9.7 | Env split: backend gets `PORT`, `APP_URL` = frontend URL; `NEXT_PUBLIC_PAYPAL_CLIENT_ID` moved to the frontend. Kept the generated `AGENT_API_KEY` |
| 9.8 | `.gitignore` rewritten for the new paths (`backend/dist/`, `frontend/.next/`, `backend/data/*` except `.gitkeep`, all `.env*` except templates) |
| 9.9 | MCP server now calls the backend directly (`http://localhost:$PORT`), not through the frontend |
| 9.10 | `render.yaml` → two services; architecture diagram redrawn with frontend/backend clusters; README + LLD updated |

Issues found and fixed in this phase:
* A sed that retargeted `./types` imports also hit `lib/llm/*`, whose `./types` is its own file → reverted for that folder.
* `cache: "no-store"` in `fetch` is a Next.js-only option → removed from the PayPal client.
* `check-ai` import path changed with the move → fixed.

Verification (`npm run build` + `npm start` from the root, then requests through the frontend's proxy):

| Test | Result |
|---|---|
| `npm run typecheck` (both), `npm run lint`, `npm run build` (tsup 72 KB bundle + Next build) | clean ✅ |
| `GET :4000/health`, frontend `/` and `/approve/x` | 200 ✅ |
| `/api/policy`, `/api/ai` through `:3000` proxy | ✅ |
| Casino credits / injection listing / earbuds via proxy | BLOCKED / BLOCKED (injection) / PENDING_APPROVAL ✅ |
| Approval detail → reject | PENDING_APPROVAL → REJECTED ✅ |
| No bearer key / invalid JSON / unknown route / no AI key | 401 / 400 / 404 JSON / clear 500 message ✅ |
| Wallet return with a bogus token | 303 redirect back to the dashboard with an error ✅ |
| `npm run mcp` (tools/list + search via MCP) and `npm run check-ai` from the root | ✅ |
| SQLite file created in `backend/data/` | ✅ (test data deleted afterwards) |

---

## Phase 10: Root cleanup review (D-044)

| Step | What |
|---|---|
| 10.1 | Reviewed the root files. `LICENSE` and `render.yaml` must stay at the root (GitHub / Render only look there). |
| 10.2 | Started converting to self-contained apps (deleted root `package.json`, lockfile, `node_modules`; began a per-folder install). The builder stopped this and chose to keep the one-command root setup. |
| 10.3 | Restored the root workspace `package.json`. |
| 10.4 | **Issue:** the interrupted per-folder install had left a full `backend/node_modules` + `backend/package-lock.json`. The next root install wrote those nested paths into the new root lockfile, so they kept coming back. **Fix:** deleted every `node_modules` and the lockfile, then ran one fresh `npm install`: a single root `node_modules`, nothing nested (verified: 0 `backend/node_modules` entries in the lockfile). |
| 10.5 | Verified: typecheck, lint and build OK; `npm start` → frontend `/` 200, backend `/health` OK, `/api/policy` through the proxy OK; servers stopped; build output and test DB removed. |

---

## Phase 11: First live test with real keys (Gemini + PayPal sandbox)

| Step | What | Result |
|---|---|---|
| 11.1 | Checked `backend/.env` / `frontend/.env.local` (values masked) | PayPal lines had spaces around `=` → normalized. `NEXT_PUBLIC_PAYPAL_CLIENT_ID` was empty → copied the (public) client id from the backend. No Groq / Claude key |
| 11.2 | `npm run check-ai` on `gemini-3.8-flash` | JSON ✓, tool calling ✗ `503 overloaded`, then timeouts |
| 11.3 | Listed the key's models; tested `gemini-3.5-flash` and `-lite` | Both ✓ → default switched (**D-045**) |
| 11.4 | Builder's own `npm run dev` was running on 3000/4000, so tests ran against it (my `npm start` exited on `EADDRINUSE`). I had deleted the test DB while the dev backend held it open → restarted the watcher (touched `server.ts`) so it created a fresh DB | Learned: check for running servers *before* resetting data |
| 11.5 | PayPal: OAuth + create sandbox order via the approval flow | ✅ order `0YR43121NT796820G` created |
| 11.6 | PayPal Vault v3 setup token (wallet connect) | ❌ `NOT_AUTHORIZED`: Vault not enabled on the sandbox app (account setting). The app falls back to approval for every purchase |
| 11.7 | Chat on Gemini: "How much budget is left?" | ✅ `get_spending_status` → correct answer ($71 left, $79 pending) |
| 11.8 | Chat: "Buy fruity, light coffee beans" | ✅ search → picked Ethiopia Yirgacheffe $18.50 → PENDING_APPROVAL (no wallet), approval link returned. Multi-step Gemini tool calling works |
| 11.9 | Rules parser on Gemini | ✅ English → `$200/week · auto-pay ≤ $20 · …` with an accurate summary |
| 11.10 | Injection prompt via chat | ✅ the agent itself refused to follow the listing; the pipeline block remains the second layer |
| 11.11 | Cleanup | Test DB reset (defaults restored), dashboard + approval page 200, builder's dev servers left running |

---

## Phase 12: Auto-pay without the standalone Vault API (D-046)

| Step | What | Result |
|---|---|---|
| 12.1 | Builder enabled "Save payment methods"; restarted the backend for a fresh PayPal token | still `NOT_AUTHORIZED` |
| 12.2 | Inspected the token's scopes (26) | no `vault/payment-tokens` scope |
| 12.3 | Direct API diagnostics: setup token for PayPal ❌, setup token for card ❌, Orders v2 with `store_in_vault: ON_SUCCESS` ✅ | standalone Vault API not granted; save-with-purchase allowed |
| 12.4 | `paypal.createOrder(..., saveWallet)` + `vaultedWallet(order)`; `createApprovalOrder(txId, saveWallet)`; capture stores the vault id → wallet CONNECTED | |
| 12.5 | `POST /api/approvals/:id/order` accepts `{saveWallet}`; `/api/wallet/connect` maps `NOT_AUTHORIZED` → friendly 409 | |
| 12.6 | Approval page: "Save my PayPal for auto-pay" checkbox (only while no wallet is connected) | |
| 12.7 | First try → `RETURN_URL_REQUIRED` (PayPal needs return/cancel URLs when vaulting) → pass the approval page URL | ✅ order `9WB09432BC970042T` created with save-wallet |
| 12.8 | typecheck + lint | ✅ |
| 12.9 | Remaining (needs a browser login): approve in the popup → capture → vault id saved → next small purchase auto-pays | builder to test |
| 12.10 | Builder's screenshot: the connect hint showed in red and read like a failure → `ApiError` carries the HTTP status; a 409 hint now shows in amber with 💡 | ✅ typecheck + lint |
| 12.11 | Builder added a Groq key → `npm run check-ai` | Gemini ✓✓, Groq ✓✓: automatic fallback is live |

---

## Phase 13: End-to-end success with real PayPal + MCP testing

| Step | What | Result |
|---|---|---|
| 13.1 | Builder's sandbox accounts were both **IN** (India): advised a **US** personal buyer account | ✅ builder approved with a sandbox buyer |
| 13.2 | Builder approved the $18.50 coffee with "Save my PayPal" ticked | ✅ captured **and** `WALLET_CONNECTED` (save-with-purchase works, D-046) |
| 13.3 | Builder approved a $34 gift via the PayPal button | ✅ captured |
| 13.4 | Socks test in chat found nothing after 4 searches → wider catalog + search limit (**D-047**) | ✅ |
| 13.5 | `npm run mcp:demo` (**D-048**) | ✅ 4 tools; tea → PENDING_APPROVAL, casino → BLOCKED, injection ×10 → BLOCKED (4 reasons) |
| 13.6 | Auto-pay test: $12 socks with intent "a pair of socks" | AI risk check **medium** ("a 6-pack, not a single pair") → approval. The check works; rejected the test tx |
| 13.7 | Auto-pay test with a matching intent | ✅ **PAID instantly with the vaulted wallet** (order `6U949337FV286672D`, capture `7XD88601B6010615A`), no popup |
| 13.8 | Refund via the API | ✅ `REFUNDED`, PayPal refund `0HP0905084474060V` (COMPLETED) |
| 13.9 | At the same moment the builder's own chat "buy socks" **auto-paid** $12 in the UI | ✅ live auto-pay seen in the dashboard |
| 13.10 | Its AI reason mentioned an earlier, unrelated "gift for mom" request → intent = latest message + labelled context (**D-049**) | ✅ typecheck |

**Status: every PayPal path is verified live:** Orders v2 create/capture, save-with-purchase vault,
merchant-initiated vaulted payments (auto-pay), refunds, plus the MCP path.

## Phase 14: Live catalog from Channel3 (D-050)

| Step | What | Result |
|---|---|---|
| 14.1 | Read the Channel3 API reference (search + product schema) | ✅ `POST /v1/search`, `GET /v1/products/{id}`, `x-api-key` |
| 14.2 | `lib/channel3.ts` client + mapping to Product/Merchant; `c3_` ids; category mapping (+ `other`) | ✅ |
| 14.3 | `catalog.ts` facade: `searchCatalog` (Channel3 → demo fallback), `resolveProduct` (fresh price at purchase) | ✅ |
| 14.4 | Wired into chat agent, `/api/agent/search`, purchase pipeline, approval page ("view listing") | ✅ typecheck + lint |
| 14.5 | New env: `CHANNEL3_API_KEY`, `CATALOG_SOURCE` | ✅ `.env.example` + `.env` |
| 14.6 | Test: no key → demo; bad key → HTTP 403 → demo; buy `c3_` id with bad key → refused | ✅ |
| 14.7 | Live test with the builder's Channel3 key: "mens running shoes" ≤ $60 | ✅ 8 real products (finishline.com, jcpenney.com, …), mapped to `clothing` |
| 14.8 | Buy a live `c3_` product ($28.99) | ✅ price re-fetched from Channel3 → PENDING_APPROVAL (over $25); test approval rejected |

## Phase 15: External-store quotes + scenario tester (D-051)

| Step | What | Result |
|---|---|---|
| 15.1 | `lib/quotes.ts` + `quotes` table; `POST/GET /api/merchant/quotes` behind `MERCHANT_API_KEY` | ✅ |
| 15.2 | `resolveProduct` understands `q_…` ids; approval page shows quote details | ✅ |
| 15.3 | `MERCHANT_API_KEY` generated into `backend/.env`, documented in `.env.example` | ✅ |
| 15.4 | `npm run external-buy -- --item "Yoga mat" --price 36` | ✅ PENDING_APPROVAL ($36 > $25 auto-pay) |
| 15.5 | `npm run external-buy -- --suite` (9 scenarios) | ✅ all as expected: $12 auto-paid then refunded; $36, 3×$9, electronics → approval; $140, gambling, unverified, injection, "socks"→headset stand → blocked |

## Phase 16: Shortlist-first chat agent (D-052)

| Step | What | Result |
|---|---|---|
| 16.1 | Agent prompt: show top 3 + ask when gender/size/variant is open; buy after the user picks | ✅ |
| 16.2 | Live test: "buy me a pair of socks under $20" | ✅ 2 options + a question, nothing bought |

## Phase 17: Accounts, per-agent allowances, PostgreSQL (D-053 – D-055)

| Step | What | Result |
|---|---|---|
| 17.1 | Builder asked to switch to the local PostgreSQL 17: `pg` in, `better-sqlite3` out; new `db.ts` (pool, migrations, JSONB/NUMERIC/TIMESTAMPTZ) | ✅ |
| 17.2 | `lib/auth.ts`: scrypt passwords, hashed session tokens, rate limit; `/api/auth/signup|login|logout|me` | ✅ |
| 17.3 | `lib/agents.ts`: per-agent keys + allowances; `/api/agents` CRUD; `/api/agent/*` authenticates by agent key | ✅ |
| 17.4 | Rules, wallet, ledger, audit, chat, approvals, refunds, webhooks all scoped per user; allowance checks in `evaluatePolicy` + transaction re-check with advisory lock | ✅ |
| 17.5 | MCP: `withdraw_purchase_request` tool; `external-buy --suite` cleans up by withdrawing | ✅ |
| 17.6 | Frontend: `/login` (log in / sign up), account menu, **Agents** tab (create + key shown once, edit allowance, pause, revoke), agent name in the ledger | ✅ typecheck + lint |
| 17.7 | `render.yaml`: free Render PostgreSQL → `DATABASE_URL` | ✅ |

## Phase 18: Per-category approval thresholds (D-056)

| Step | What | Result |
|---|---|---|
| 18.1 | Builder: auto-pay $100 but a $46.15 tracker still asked → explained "always ask: electronics" | ✅ working as designed |
| 18.2 | `categoryAskAbove` in Policy, engine, describe, sanitise, rule-parser prompt; chip in Rules panel | ✅ typecheck + lint |
| 18.3 | Engine test: electronics over $50 → $46.15 ALLOW, $79 NEEDS_APPROVAL | ✅ |
| 18.4 | Parser test (Groq after Gemini hit its free quota) | ✅ both sentences parsed correctly |

## Phase 19: Remote MCP + decision timeline (D-057, D-058)

| Step | What | Result |
|---|---|---|
| 19.1 | `src/mcp/tools.ts` (shared tool definitions) + `src/mcp/ops.ts` (shared agent operations) | ✅ REST, remote MCP and stdio all use them |
| 19.2 | `POST /mcp`: stateless Streamable HTTP, agent key as Bearer | ✅ wrong key → 401; 5 tools; status/search/purchase/withdraw |
| 19.3 | `checks` timeline recorded by the pipeline; `transactions.checks` column | ✅ casino BLOCKED + 2× tea auto-paid both have full timelines |
| 19.4 | Test side effect: 2× tea ($58) auto-paid under the builder's $100 rule → refunded | ✅ PayPal refund `58Y37885247247030` |
| 19.5 | UI: `DecisionTimeline` in ledger + approval page; Agents tab shows MCP URL + client config | ✅ typecheck, lint, `next build` |

## Phase 20: Redundant thresholds fix (D-059)

| Step | What | Result |
|---|---|---|
| 20.1 | Builder spotted "ask for <every category> over $150" after a rules update | ✅ confirmed parser bug |
| 20.2 | `sanitizePolicy` drops thresholds ≥ auto-pay limit (on save and read); stricter parser prompt | ✅ saved rules clean, real thresholds kept, re-parse gives none |

## Next steps (to do with real keys)
1. Fill `backend/.env` and `frontend/.env.local` (see README) → `npm run check-ai` → `npm run dev`.
2. Live end-to-end test: connect the sandbox wallet (Vault) → auto-pay → approval → refund.
3. Deploy to Render, set `APP_URL`, add the PayPal webhook, record the < 3 min demo video.
