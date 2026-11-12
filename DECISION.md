# DECISION.md: Architecture & Decision Log

Every meaningful decision in this project is recorded here: what was decided, why, what else was
considered, and whether it was later changed. Entries are append-only. When a decision changes, a
new entry supersedes the old one and the old one is marked **Superseded**, so the history of
shifts in approach stays visible.

Format: **D-xxx · Title** → Context · Decision · Why · Alternatives considered · Status

---

## D-001 · Project idea: a trust layer for agent payments ("Allowance")

* **Context.** The hackathon asks for something that "meaningfully uses both PayPal and AI" and
  frames itself as "what happens when you put AI behind the wheel… AI agents interact with money".
* **Decision.** Build *Allowance*: users give an AI agent a PayPal "allowance" with rules
  (budget, merchant allow-list, approval thresholds). The agent shops; every payment goes through
  a policy engine + AI risk check, and either auto-pays, asks a human, or is blocked.
* **Why.** It sits on PayPal's own strategic theme (agentic commerce), but targets the unsolved
  part: *trust*. PayPal is the core of the product (vaulted wallet, orders, refunds, webhooks), and
  removing the AI removes the product. It also demos well in 3 minutes (auto-pay → approval →
  block → refund).
* **Alternatives.** (a) AI invoicing back-office for freelancers: practical but crowded and less
  novel. (b) Group bill-splitting with receipt OCR: common hackathon idea, and PayPal is less central.
  (c) Dispute-resolution copilot: sandbox disputes are awkward to simulate reliably for judges.
* **Status.** Accepted.

## D-002 · Single Next.js (App Router) + TypeScript app  ·  **Superseded by D-038**

* **Context.** Solo builder, limited time, judges must be able to run it.
* **Decision.** One Next.js 16 project holds UI, API routes, and the server-side agent. TypeScript
  everywhere.
* **Why.** One `npm install && npm run dev` to run; one service to deploy; shared types between UI
  and API; React is needed anyway for PayPal's official `@paypal/react-paypal-js` buttons.
* **Alternatives.** Separate React SPA + Express/FastAPI backend (two deploys, CORS, more setup
  for judges); Python + Streamlit (fast, but PayPal JS SDK buttons and a polished UI are harder).
* **Status.** Superseded by D-038 (split into `frontend/` and `backend/`).

## D-003 · Claude (Anthropic API) as the AI, with tool use  ·  **Superseded by D-032**

* **Context.** Need an LLM that can reliably call tools, follow constraints, and return structured
  JSON for the risk check and rule parsing.
* **Decision.** Anthropic TypeScript SDK (`@anthropic-ai/sdk`), default model `claude-opus-5-5`
  (configurable via `ANTHROPIC_MODEL`). Three AI uses: the shopping agent (tool-use loop), the
  intent/risk checker (structured output), and the English→policy parser (structured output).
* **Why.** Strong tool-use reliability; structured outputs (`messages.parse` + Zod) give
  schema-valid JSON for the safety-critical bits; the same vendor powers Claude Desktop, so the
  MCP story ("any agent can shop through Allowance") is demonstrable.
* **Alternatives.** OpenAI / Gemini: equivalent capability, but would split the MCP demo across
  vendors. Local models: not reliable enough for money-moving tool calls.
* **Status.** Superseded by D-032 (Claude is still supported, but no longer the only or default provider).

## D-004 · Manual agent loop instead of the SDK Tool Runner

* **Decision.** Write the `while (stop_reason === "tool_use")` loop by hand in `lib/agent.ts`.
* **Why.** We need a full trace of every tool call for the UI (judges see *why* the agent did
  what it did), a hard iteration cap, and server-injected context (the user's real intent) on
  `request_purchase`. The Tool Runner is a beta helper; the manual loop has no beta dependency.
* **Alternatives.** `client.beta.messages.toolRunner()`: less code, but less control over tracing.
* **Status.** Accepted.

## D-005 · The AI proposes, deterministic code decides

* **Context.** LLMs can be wrong or prompt-injected (e.g. by a product description).
* **Decision.** All hard limits (budget, caps, merchant allow-list, blocked categories) are
  enforced in plain TypeScript (`lib/policy.ts`). Prices come from the server catalog, not the
  agent. The AI risk check can only make a decision *stricter* (ALLOW → APPROVAL → BLOCK), never
  looser. If the AI check fails, it fails safe to "needs human approval".
* **Why.** A trust product cannot let the model talk itself past a spending limit. This is the
  core differentiator in the pitch.
* **Status.** Accepted.

## D-006 · PayPal Vault v3 for agent auto-pay; Smart Buttons for human approval

* **Context.** Auto-pay without a popup needs a stored PayPal payment method. Larger purchases
  need explicit human consent.
* **Decision.** "Connect wallet" uses Vault v3 *save PayPal without purchase* (setup token →
  buyer approves → payment token). Auto-pay creates an Orders v2 order with
  `payment_source.paypal.vault_id`. Approvals use the JS SDK Smart Buttons on `/approve/:id`.
* **Why.** It's the real PayPal pattern for merchant-initiated payments with a saved PayPal wallet,
  and it shows two different PayPal integration styles (server-to-server vault, client-side buttons).
* **Fallback.** If vaulting is not enabled on the sandbox app, or no wallet is connected,
  every purchase routes to human approval, so the demo still works end-to-end.
* **Alternatives.** Billing agreements / reference transactions (legacy v1, deprecated);
  Payouts API (wrong money direction); everything through buttons (not agentic).
* **Status.** Accepted.

## D-007 · SQLite via better-sqlite3

* **Decision.** Local SQLite file in `data/allowance.db`, created and migrated on first run.
* **Why.** Zero setup for judges (no DB server), synchronous API makes the budget check + insert
  atomic, and Next.js already treats `better-sqlite3` as a server-external package.
* **Alternatives.** Postgres (needs a server/account), JSON files (no atomicity), Node's built-in
  `node:sqlite` (still experimental; bundler support is uncertain).
* **Trade-off.** On Render's free tier the disk is ephemeral, so data resets on redeploy. That's
  acceptable for a demo and documented in the README.
* **Status.** Accepted.

## D-008 · Single-user demo, no login

* **Decision.** One implicit user; policy/wallet rows keyed `'default'`.
* **Why.** Judges should be in the product within seconds. Auth adds nothing to the PayPal + AI
  evaluation. The external-agent API is still protected by a bearer key (D-010).
* **Status.** Accepted (would be the first thing to add post-hackathon).

## D-009 · All sandbox payments settle to one merchant account

* **Decision.** The demo "merchants" (coffee shop, gift store, etc.) are catalog entries; PayPal
  orders go to the app's sandbox merchant account, with the merchant name in the order description.
* **Why.** Paying real third-party merchants needs PayPal multiparty / partner onboarding, which is
  out of scope for a hackathon sandbox.
* **Status.** Accepted.

## D-010 · MCP server so *any* agent can shop through Allowance

* **Decision.** A small stdio MCP server (`mcp/server.mts`, official `@modelcontextprotocol/sdk`)
  exposes `search_products`, `get_spending_status`, `request_purchase`, `list_transactions`.
  It calls the app's `/api/agent/*` routes with `AGENT_API_KEY`.
* **Why.** It turns the project from "an app with a chatbot" into "a platform/trust layer for
  every agent", which is the stronger pitch. External agents hit the *same* pipeline (D-005).
* **Alternatives.** An HTTP MCP endpoint inside Next.js: works remotely but adds session plumbing;
  stdio is what Claude Desktop supports most simply.
* **Status.** Accepted.

## D-011 · Live ledger by polling, not websockets

* **Decision.** Dashboard polls `GET /api/transactions` every 3 s.
* **Why.** Works on any host (Render free tier, localhost) with no extra infra; the data is tiny.
* **Status.** Accepted.

## D-012 · Webhooks are a bonus, not a dependency

* **Decision.** State is updated synchronously from PayPal API responses; webhooks
  (signature-verified) reconcile and add audit events when a public URL exists.
* **Why.** PayPal can't call `localhost`, and judges running locally must still get a working app.
* **Status.** Accepted.

## D-013 · Server-side, append-only conversation storage

* **Decision.** Store each chat's full Anthropic message history (including tool_use/tool_result
  blocks) server-side, appending the full `response.content` each turn.
* **Why.** The agent remembers which products it already looked at between turns; append-only
  history is what current Claude models expect (editing past turns invalidates thinking blocks).
* **Status.** Accepted.

## D-014 · Refunds are human-only

* **Decision.** No refund tool for the agent; refunds happen from the ledger UI.
* **Why.** Undo should belong to the human. It also keeps the agent's permissions minimal.
* **Status.** Accepted.

## D-015 · Tailwind CSS for styling

* **Decision.** Tailwind (ships with `create-next-app`).
* **Why.** Fast to build a polished UI without a component library dependency.
* **Status.** Accepted.

## D-016 · Documentation artefacts

* **Decision.** `architecture.png` is generated from `docs/architecture.dot` (Graphviz) so it can
  be re-rendered whenever the design changes; `docs/LLD.md` holds the detailed design.
* **Why.** Diagram-as-code stays in sync with the repo and is reviewable in diffs.
* **Status.** Accepted.

## D-017 · Keep Next.js 16 "Cache Components" on; call `connection()` before SQLite reads  ·  **Obsolete after D-038**

* **Context.** `create-next-app@16` enables `cacheComponents` by default. In this mode, GET route
  handlers are prerendered at build time unless they touch request data. better-sqlite3 is
  *synchronous*, so a query would silently run during the build and freeze the ledger.
* **Decision.** Keep the framework default and call `await connection()` at the top of every GET
  handler that reads the database (the exact pattern Next's own docs give for synchronous DB
  drivers). The static `/api/catalog` route is intentionally left prerenderable.
* **Alternatives.** Turn `cacheComponents` off (fights the framework default); `force-dynamic`
  route config (not supported with Cache Components).
* **Status.** Obsolete: after D-038 the database is only touched by the Hono backend, which has no
  prerendering. Cache Components stays on in the frontend (pages only).

## D-018 · Call the PayPal REST API directly (no server SDK)

* **Decision.** `lib/paypal.ts` is a ~200-line typed `fetch` client: OAuth client-credentials
  with token caching, `PayPal-Request-Id` on every POST, `Prefer: return=representation`, and a
  `PayPalError` that keeps PayPal's `debug_id`.
* **Why.** We need Orders v2, Vault v3 (setup/payment tokens), Payments refunds and webhook
  verification together. Calling REST directly keeps every request visible to the judges, maps 1:1
  to PayPal's API docs, and avoids SDK coverage gaps for Vault v3.
* **Alternatives.** `@paypal/paypal-server-sdk`: typed, but adds abstraction over exactly the
  requests we want to show.
* **Status.** Accepted. The *client side* still uses the official `@paypal/react-paypal-js`.

## D-019 · Server-side refusal fallback on every Claude call  ·  *still applies to the Claude provider (D-032)*

* **Decision.** All Claude calls use the beta Messages API with
  `fallbacks: "default"` + beta `server-side-fallback-2026-07-01`.
* **Why.** Shopping requests occasionally look odd out of context. If the primary model declines,
  the API re-runs the same request on a fallback model inside the same call instead of breaking
  the purchase flow. `stop_reason === "refusal"` is still handled (the risk check fails safe).
* **Status.** Accepted.

## D-020 · `PROCESSING` status for auto-pay in flight

* **Context.** First draft inserted auto-pay transactions as `PAID` *before* PayPal captured.
* **Decision (change).** Insert as `PROCESSING`, flip to `PAID` only after a COMPLETED capture
  (or to `FAILED`). `PROCESSING` still counts against the budget.
* **Why.** The ledger must never claim money moved when it didn't; the budget must still be
  reserved so two concurrent purchases can't overspend.
* **Status.** Accepted (supersedes the provisional-PAID approach in the first draft of `purchase.ts`).

## D-021 · Rules before AI; budget re-checked inside a DB transaction

* **Decision.** Deterministic rules run first: a blocked purchase never costs an AI call or
  touches PayPal. After the (async) AI risk check, the budget is re-evaluated and the row inserted
  inside one `BEGIN IMMEDIATE` SQLite transaction.
* **Why.** Cheaper, faster, and closes the race where two purchases both pass the first budget
  check while waiting on the AI.
* **Status.** Accepted.

## D-022 · The server decides the "user intent" the risk check sees

* **Decision.** For chat, `userIntent` = the user's last three messages, taken from stored
  history; the agent cannot write it. For MCP clients, the external agent passes `intent`
  (it is authenticated by `AGENT_API_KEY` and still subject to all rules).
* **Why.** If the agent could describe the user's intent itself, a prompt-injected agent could
  justify anything to the risk checker.
* **Status.** Accepted.

## D-023 · Webhooks require a valid signature; unsigned events are rejected

* **Decision.** `/api/paypal/webhook` verifies every event with
  `/v1/notifications/verify-webhook-signature` and de-duplicates by event id. Without
  `PAYPAL_WEBHOOK_ID` it rejects everything (401).
* **Why.** A webhook can change a payment's status; it must not be forgeable.
* **Status.** Accepted.

## D-024 · Audit helpers live in `lib/db.ts`

* **Context.** The LLD listed a separate `lib/audit.ts`.
* **Decision (change).** `audit()` / `listAuditEvents()` were put in `lib/db.ts` next to the other
  row helpers; the module would have been ten lines.
* **Status.** Accepted; LLD updated.

## D-025 · PayPal JS SDK **v6** for the approval button

* **Context.** `@paypal/react-paypal-js` v10 defaults to the new JS SDK v6
  (`PayPalProvider` + `PayPalOneTimePaymentButton`); the v5 `PayPalScriptProvider` API is legacy.
* **Decision.** Use v6 (`@paypal/react-paypal-js/sdk-v6`) on `/approve/:id`, with server-side
  `createOrder` / `capture` routes.
* **Why.** It is PayPal's current recommended integration; judges from PayPal will recognise it.
* **Status.** Accepted.

## D-026 · Wallet connect uses the Vault v3 redirect flow, not the `PayPalSavePaymentButton`

* **Decision.** "Connect PayPal" creates a setup token server-side and redirects to PayPal's
  approve link; PayPal redirects back to `/api/wallet/return`.
* **Why.** Fully server-driven, works without the JS SDK loaded on the dashboard, and the return
  route validates that the token matches the one we created.
* **Alternative.** v6 `PayPalSavePaymentButton` (popup), a nice UX upgrade later.
* **Status.** Accepted.

## D-027 · Lint-driven React patterns (React Compiler rules)

* **Context.** ESLint (`react-hooks/set-state-in-effect`) flagged synchronous `setState` in effects.
* **Decision (change).** Fetches set state only in promise callbacks; the wallet-connect notice is
  *derived from the URL* (`useSearchParams` inside `<Suspense>`) instead of copied into state.
* **Status.** Accepted.

## D-028 · Conversation id created on first message, not during render

* **Context.** `next build` failed: with Cache Components, `crypto.randomUUID()` during prerender
  is not allowed.
* **Decision (change).** Keep the id in a `useRef`, created lazily in the send handler.
* **Status.** Accepted.

## D-029 · Route error wrapper re-throws Next.js internal errors  ·  **Obsolete after D-038**

* **Context.** The build logged `HANGING_PROMISE_REJECTION`: our `handle()` try/catch was
  swallowing Next's prerender-abort signal from `connection()`.
* **Decision.** Call `unstable_rethrow(err)` first in the catch block.
* **Status.** Accepted.

## D-030 · MCP server is an `.mts` file run with `tsx`  ·  **Superseded by D-043**

* **Context.** `tsx mcp/server.ts` failed: without `"type": "module"` in `package.json`, `.ts` is
  compiled as CommonJS and top-level `await` is rejected.
* **Decision (change).** Rename to `mcp/server.mts` (always ESM). No change to how Next builds the app.
* **Why.** Adding `"type": "module"` project-wide would affect Next/ESLint config resolution for no gain.
* **Status.** Accepted.

## D-031 · Render Blueprint for the hosted demo  ·  *updated by D-042 (two services)*

* **Decision.** `render.yaml` (free web service, Node 22, `npm ci && npm run build`, health check
  `/api/catalog`, `AGENT_API_KEY` auto-generated).
* **Why.** The hackathon lists Render as a sponsor and requires a runnable demo; one-click
  deploy plus a hosted URL covers both options of the "functional demo" requirement.
* **Status.** Accepted.

## D-032 · Provider-neutral AI layer: Gemini and Groq (free) + Claude (optional)  ·  *shift in approach*

* **Context.** The builder is a student without a paid AI budget. The original design (D-003) required
  a paid Anthropic key, for the builder and for every judge running the project locally.
* **Decision.** Introduce `lib/llm`, a small provider-neutral interface (`chat()` for tool-use
  turns, `json()` for schema-validated JSON) with three implementations: **Gemini** and **Groq**
  (free tiers) and **Claude** (paid, optional). The agent, risk check and rule parser call only
  this interface. Conversations are stored in a neutral `ChatItem` format.
* **Why.** Removes the paid-key barrier for the builder *and* the judges (a project judges can run
  for free is easier to evaluate) without giving up Claude when credits are available.
* **Trade-offs accepted.** Free models are somewhat less reliable at multi-step tool use and at
  spotting manipulation. This is mitigated by D-005 (hard limits are code, not AI), D-035
  (deterministic injection screen) and the fail-safe risk check.
* **Alternatives.** (a) Keep Claude only: blocks the builder. (b) Gemini only: one free quota,
  no fallback. (c) A framework such as LangChain / Vercel AI SDK: more dependencies and less
  control over the exact requests than ~300 lines of our own code.
* **Status.** Accepted.

## D-033 · Gemini and Groq through their OpenAI-compatible APIs (official `openai` SDK)

* **Decision.** One implementation (`lib/llm/openai-compat.ts`) serves both, with per-provider
  settings: base URL, `reasoning_effort` (Gemini always; Groq only for `gpt-oss` models, since
  Llama rejects it), JSON mode (`json_schema` on Gemini with fallback to `json_object`;
  `json_object` + schema-in-prompt on Groq). Every JSON result is Zod-validated with one repair retry.
* **Why.** Both providers officially support the OpenAI Chat Completions format, so one tested
  code path covers both, with typed errors and retries from the SDK.
* **Detail.** Each assistant message is stored with the provider's raw message and replayed
  verbatim when the same provider continues the turn. This preserves Gemini *thought signatures*
  (needed for multi-step function calling on Gemini 3+) without hard-coding their field names.
* **Defaults.** `gemini-3.8-flash` (Google's current recommended Flash model) and
  `openai/gpt-oss-120b` (Groq, supports tool use). Both can be overridden in `.env`.
* **Status.** Accepted.

## D-034 · Automatic provider fallback chain

* **Decision.** `LLM_PROVIDER` is tried first, then `LLM_FALLBACKS` (default: every other
  provider with a key; default order gemini → groq → anthropic). Each SDK retries once (honouring
  `retry-after`, 45–60 s timeout); then the next provider is tried. Rate limits, outages,
  bad keys, rejected requests and invalid JSON all fall through; a *refusal* does not (it is an
  answer, not an outage). The agent stays on the provider that started a turn when it can.
* **Why.** Free tiers have small per-minute and per-day quotas (reported as low as 5–15 requests/min
  for Gemini Flash). Two free providers covering each other make a live demo much less likely to fail.
* **Status.** Accepted.

## D-035 · Deterministic prompt-injection screen

* **Decision.** `lib/injection.ts` checks every listing with regexes (addresses AI agents,
  "note to the AI", "ignore your limits", "pre-approved by the user", dictated quantity,
  "system prompt / new instructions"). A hit → BLOCKED, before any AI call.
* **Why.** Smaller free models may miss injection. This makes the demo's injection test pass on
  any model at zero cost. The AI risk check remains a second layer.
* **Trade-off.** Regexes can false-positive. The quantity rule is deliberately narrow ("buy
  quantity 10", "quantity: 10") so normal offers like "buy 2 get 1 free" pass.
* **Status.** Accepted.

## D-036 · AI risk check only where it matters (`RISK_CHECK=autopay`)

* **Decision (change).** The pipeline now checks the wallet first, and runs the AI risk check
  only when the purchase would otherwise be **paid automatically**. Purchases a human will approve
  anyway skip it, with the reason shown ("you are reviewing this purchase yourself").
  `RISK_CHECK=always` restores the old behaviour.
* **Why.** Saves one AI call per approval-bound purchase on tight free quotas, while keeping the
  guarantee that **no money moves without either a human or an AI check**.
* **Status.** Accepted (changes the order in D-021: rules → injection → wallet → AI → DB re-check).

## D-037 · `npm run check-ai` key checker

* **Decision.** `scripts/check-ai.mts` runs one JSON call and one tool call on every configured
  provider and prints ✓/✗ with the error.
* **Why.** Lets the builder and judges confirm free keys work in 10 seconds, before debugging the app.
* **Status.** Accepted.

## D-038 · Split into `frontend/` and `backend/`  ·  *shift in approach*

* **Context.** Requested by the builder: the repo should read as a clean frontend + backend
  project. In the single Next.js app, UI, API routes and server logic were mixed in `app/` and `lib/`.
* **Decision.** Two apps in one repo:
  * `frontend/`: Next.js UI only (pages, components, styles). No database, secrets or server logic.
  * `backend/`: standalone Node API (Hono) holding everything that touches money, keys or data:
    purchase pipeline, policy engine, PayPal client, AI layer, SQLite, MCP server, scripts.
* **Why.** Clear ownership (the trust core can't be bundled into the browser by accident), each
  part can be run, tested and deployed on its own, and it matches how judges expect a full-stack
  project to look. The backend no longer depends on Next.js quirks (D-017, D-029 become obsolete).
* **Trade-off.** Two processes and two deploys instead of one; mitigated by D-043 (one command)
  and D-040 (no CORS setup).
* **Status.** Accepted (supersedes D-002).

## D-039 · Hono for the backend HTTP server

* **Decision.** `hono` + `@hono/node-server`, one router file per area in `backend/src/routes/`.
* **Why.** Hono handlers use the same Web `Request`/`Response` model as the Next route handlers
  they replace, so the port was mostly mechanical. It is small, TypeScript-first and fast, and has
  built-in CORS and middleware.
* **Alternatives.** Express: more familiar, but callback-style `req/res` would mean rewriting every
  handler, and it needs extra packages for typing and JSON errors. Fastify: heavier setup for this size.
* **Status.** Accepted.

## D-040 · Frontend proxies `/api/*` to the backend (Next.js rewrites)

* **Decision.** `frontend/next.config.ts` rewrites `/api/:path*` → `${BACKEND_URL}/api/:path*`.
  `APP_URL` (backend env) is the *frontend* URL.
* **Why.** The UI keeps calling relative `/api/...` URLs (no code changes, no CORS), and PayPal's
  wallet-connect redirect to `APP_URL/api/wallet/return` reaches the backend through the proxy
  and redirects back to the dashboard. The backend still enables CORS for `APP_URL` in case the API
  is called directly.
* **Trade-off.** `BACKEND_URL` is read at build time; on Render the frontend must be redeployed
  after setting it (documented).
* **Status.** Accepted.

## D-041 · Shared API types live in the backend; the frontend imports them type-only

* **Decision.** `backend/src/shared/types.ts` holds every type the UI needs (Transaction, Policy,
  SpendSummary, …). The frontend imports it with the alias `@shared/*`, always as `import type`,
  so nothing from the backend is bundled into the browser. The backend's Zod `PolicySchema` is
  checked at compile time to match the shared `Policy` type (`satisfies z.ZodType<Policy>`).
* **Why.** One source of truth for the API shape without a third package. Exactly two top-level
  app folders, as requested.
* **Alternative.** A `shared/` workspace package: cleaner for big teams, overkill here.
* **Status.** Accepted.

## D-042 · Backend build with tsup; separate env files; two Render services

* **Decision.** `tsup` bundles `backend/src` into `dist/server.js` (npm deps stay external, so the
  native `better-sqlite3` still loads from `node_modules`); `npm start` runs it with Node's
  `--env-file-if-exists=.env`. Secrets live in `backend/.env`; the frontend has only
  `BACKEND_URL` and the public `NEXT_PUBLIC_PAYPAL_CLIENT_ID` in `frontend/.env.local`.
  `render.yaml` now defines `allowance-backend` (health check `/health`) and `allowance-frontend`.
* **Why.** Production runs plain compiled JavaScript (no TypeScript loader). Secrets physically
  can't reach the frontend build. Each service scales and restarts independently.
* **Status.** Accepted.

## D-043 · npm workspaces + one root command; backend is an ES-module package

* **Decision.** The root `package.json` declares workspaces `backend` and `frontend`. Root scripts
  (`dev`, `build`, `start`, `typecheck`, `lint`, `check-ai`, `mcp`) drive both, and `concurrently`
  runs both servers with labelled output. `backend/package.json` has `"type": "module"`, so the
  MCP server and scripts are plain `.ts` files again (superseding the `.mts` workaround of D-030).
* **Why.** Judges still do a single `npm install` + `npm run dev`. One lockfile, one `node_modules`.
* **Status.** Accepted.

## D-044 · What lives at the repo root, and why  ·  *reviewed, D-043 kept*

* **Context.** Question during cleanup: aren't `package.json`, `package-lock.json`, `node_modules`,
  `render.yaml` and `LICENSE` frontend files? Briefly considered making each app fully self-contained
  (own `package.json` / lockfile / `node_modules`, no root install), then **kept the single root setup**.
* **Decision.** The root holds only project-wide files:
  | File | Why it must be at the root |
  |---|---|
  | `package.json` + `package-lock.json` + `node_modules/` | npm workspaces: one install and one `npm run dev` start both servers (D-043). Not frontend files: they install *both* apps. |
  | `render.yaml` | Render only reads a Blueprint from the repo root; it deploys both services. |
  | `LICENSE` | GitHub detects the license (shown in the repo's About section, a hackathon requirement) only at the root. |
  | `README.md`, `DECISION.md`, `FLOW.md`, `architecture.png`, `docs/` | Project documentation for judges. |
  | `.gitignore` | One ignore file for the whole repo. |
* **Why not self-contained apps.** It would mean two installs and two terminals for judges, for a
  purely cosmetic gain.
* **Status.** Accepted.

## D-045 · Default Gemini model → `gemini-3.5-flash`  ·  *updates D-033*

* **Context.** First live test with the builder's free key: `gemini-3.8-flash` (newest) answered
  one request, then returned `503` (model overloaded) and network timeouts. `gemini-3.5-flash` and
  `gemini-3.5-flash-lite` both passed JSON output and tool calling (`npm run check-ai`).
* **Decision.** Default `GEMINI_MODEL=gemini-3.5-flash` (code default, `.env`, `.env.example`, README).
  The newest model can still be chosen in `.env` when it's less busy.
* **Why.** On free tiers, a stable model beats the newest one, especially for a live demo.
  Recommended mitigation: add a free `GROQ_API_KEY` so an outage falls through to Groq automatically.
* **Status.** Accepted.

## D-046 · Save the PayPal wallet *with a purchase* (Orders v2 `store_in_vault`)  ·  *updates D-006 / D-026*

* **Context.** Live test: with "Save payment methods" ticked, the builder's sandbox app still gets
  **no** `vault/payment-tokens` scope. Standalone Vault v3 setup tokens (PayPal *and* card) return
  `NOT_AUTHORIZED`, while an Orders v2 order with
  `payment_source.paypal.attributes.vault.store_in_vault = ON_SUCCESS` is accepted.
* **Decision.** Two ways to turn on auto-pay:
  1. **Primary, works now: save with purchase.** The approval page shows "Save my PayPal for
     auto-pay" (ticked by default while no wallet is connected). The order is created with
     `store_in_vault: ON_SUCCESS` (+ the required `return_url` / `cancel_url`). After capture, the
     vault id from `payment_source.paypal.attributes.vault.id` is stored and auto-pay turns on.
  2. **Standalone "Connect PayPal"** (Vault v3 setup token) is kept. If PayPal answers
     `NOT_AUTHORIZED`, the API returns a 409 telling the user to use option 1.
* **Why.** It works with the permissions PayPal actually grants this account today, and it's the
  natural UX anyway ("approve once, and next time it's automatic"). Later charges use the vault id
  through Orders v2, which the app is authorized for.
* **To verify in the browser.** That the capture response includes the vault id for this account,
  and that a vaulted order then completes without a popup.
* **Status.** Accepted.

## D-047 · Wider demo catalog + "at most two searches" agent rule

* **Context.** Builder asked for "a pair of socks under $20": the catalog had no clothing, and the
  agent searched **four** times before giving up, wasting free-tier quota. The `home` category had no products.
* **Decision.** Added two verified merchants (Threadly Apparel, Hearth & Home) with 5 clothing and 4
  home products. The agent's system prompt now lists the catalog's categories and allows at most one
  broader retry before telling the user the item isn't sold here.
* **Why.** Judges will type random items. The agent should either find something sensible or say
  so quickly, in at most 2 tool calls.
* **Status.** Accepted.

## D-048 · `npm run mcp:demo`: a scripted external agent

* **Decision.** `backend/scripts/mcp-demo.ts` uses the official MCP **client** SDK to start the MCP
  server over stdio (exactly as Claude Desktop does), list tools, read the budget, search, and
  request three purchases that show approve / block / injection-block. README also documents the
  MCP Inspector and a Claude Desktop config with absolute paths.
* **Why.** Lets the builder and judges prove the "any agent can shop through Allowance" claim in
  one command, without installing or signing in to anything.
* **Status.** Accepted.

## D-049 · Risk check judges the *latest* request; earlier messages are context only  ·  *refines D-022*

* **Context.** Live ledger: a socks purchase was approved with the AI reason *"fit the
  relaxed-evening gift idea"*: the intent string had been "last 3 user messages joined", so an
  unrelated earlier request (a gift for mom) leaked into the judgement.
* **Decision.** `userIntent` = the latest user message, followed by up to two earlier messages
  explicitly labelled "for context only". The risk prompt says to judge against the current request.
* **Why.** Keeps follow-ups like "yes, buy it" working, without stale requests skewing the check.
* **Status.** Accepted.

## D-050 · Live catalog from Channel3, demo catalog as fallback  ·  *extends D-005 / D-047*

* **Context.** The builder wanted a real, external product catalog instead of only the fixed demo
  list. Channel3 (a hackathon sponsor) offers a product-search API built for AI agents.
* **Decision.** New `backend/src/lib/channel3.ts` calls `POST /v1/search` and
  `GET /v1/products/{id}` (header `x-api-key`, 8 s timeout). `catalog.ts` gets a small facade:
  * `searchCatalog()`: Channel3 first; **falls back to the demo catalog** when there is no key,
    `CATALOG_SOURCE=demo`, Channel3 errors (401/403/402/5xx/timeout) or it finds nothing.
  * `resolveProduct(id)`: ids are namespaced: `c3_…` = Channel3, `p_…` = demo. A `c3_` product is
    **fetched again at purchase time** and the price charged is that live price (D-005 still
    holds: the agent never supplies a price). If Channel3 can't be reached at purchase time we
    **refuse** rather than trust a cached price.
  * Offer choice: the cheapest **in-stock USD** offer, same rule at search and purchase time.
  * Merchant = the retailer's domain (`c3m_<domain>`), treated as **verified** (Channel3 indexes
    real storefronts); the prompt-injection screen and AI risk check still run on every listing.
  * Channel3's category tree is mapped by keywords onto our rule categories so "always ask:
    electronics" / "block gambling" still apply; unknown → new category **`other`**.
  * `rating` / `deliveryDays` became nullable (live products may not have them).
* **Why not mix live + demo results?** The builder chose "Channel3, and the existing one when it
  doesn't work". The demo ids (`p_casino_credits`, `p_mega_giftcard`) still resolve directly, so
  the safety demos keep working; `CATALOG_SOURCE=demo` switches search back for recording them.
* **Trade-off.** Payments still settle to the one sandbox merchant (D-009), not the real retailer.
* **Status.** Accepted. Verified: no key → demo; bad key → 403 → demo; buying a `c3_` id with a
  bad key → refused with "couldn't verify the live price".

## D-051 · Merchant checkout quotes + `npm run external-buy` scenario tester  ·  *extends D-005 / D-010*

* **Context.** The builder wanted to test "I'm buying a $36 item from some external website", and
  other what-ifs, but an agent can only send a product id, never a price (D-005), so arbitrary
  items/prices couldn't be tried.
* **Decision.** Model it the way real agentic checkout works: the **store** states the price.
  * `POST /api/merchant/quotes` (auth: `MERCHANT_API_KEY`, a *separate* key from `AGENT_API_KEY`)
    takes `{merchant, item, price, category, description, url, sellerVerified, rating, deliveryDays}`
    and returns a quote id `q_…` (valid 24 h, stored in a new `quotes` SQLite table).
  * The agent pays with `request_purchase(product_id: "q_…")`; `resolveProduct` turns the quote
    into a product + merchant, and **everything else is unchanged**: rules, injection screen, AI
    risk check, budget re-check, PayPal.
  * `scripts/external-buy.ts` plays both sides (store via HTTP, agent via the real MCP server):
    one custom purchase from CLI flags, or `--suite` with 9 scenarios that clean up after
    themselves (reject approvals, refund auto-payments).
  * `CATEGORIES` moved to `lib/categories.ts` to avoid a catalog ↔ quotes import cycle.
* **Why a separate merchant key, not a "price" field on request_purchase?** Whoever holds the
  agent key must not be able to name a price; that is the attack Allowance exists to stop. The
  store and the agent are different trust domains, so they get different keys.
* **Status.** Accepted. Verified: suite results matched the expected verdict for all 9 cases
  (auto-pay $12 + refund, approval ×3, cap, gambling, unverified, injection, intent mismatch).

## D-052 · Shortlist first, buy second (chat agent)  ·  *refines D-022 / D-047*

* **Context.** Builder: "buy a pair of shoes under $10" could auto-pay for women's shoes when
  they wanted men's. The rules only check *money* (price, budget, seller, category); whether the
  *right variant* was picked depends on the agent.
* **Decision.** System-prompt rule: buy immediately only when the request pins down one product.
  If details that matter are missing (men's/women's/kids', size, colour, variant, brand) or several
  results fit equally, show the top 3 and ask the deciding question; buy after the user picks.
  Never guess a gender, size or variant.
* **Why a prompt rule, not a policy rule?** "Which details matter" depends on the product and the
  wording, which is exactly what the model is good at; the deterministic rules stay about money.
  The AI risk check is the backstop: an item that doesn't match the request ("socks" → headset
  stand) can't be auto-paid (seen in the D-051 suite).
* **Status.** Accepted. Verified: "buy me a pair of socks under $20" → 2 options + a question, no purchase.

## D-053 · Accounts: email + password login; everything per user  ·  *replaces D-008 (single-user demo)*

* **Context.** Builder asked for login, and for each user's PayPal auto-pay to be linked to that
  user. Before, the app had one global policy, wallet and ledger, and no login at all: anyone with
  the URL could approve or refund.
* **Decision.**
  * `users` (email + **scrypt** password hash with a per-user salt) and `sessions` (random 32-byte
    token in an **HttpOnly, SameSite=Lax** cookie, Secure on https; only its SHA-256 is stored,
    30-day expiry). Login/sign-up rate-limited (10 failures / 15 min per IP + email).
  * Every table is keyed by user: rules (`policies`), saved PayPal (`wallets`), purchases, audit
    trail, conversations. Each user links **their own** PayPal; one user's agents can never charge
    another user's wallet. Other users' purchases look like "not found".
  * Approval, refund, wallet and chat routes need a session; the frontend redirects to `/login`
    on 401 and comes back afterwards (`?next=`, same-site paths only).
* **Why build it, not use an auth SaaS?** No extra accounts or keys for judges, works offline,
  ~150 lines with Node's built-in crypto. **Trade-off:** no email verification or password reset yet.
* **Status.** Accepted.

## D-054 · Per-agent allowances, each agent with its own API key  ·  *replaces the shared AGENT_API_KEY of D-010*

* **Context.** The "trust layer for agents" pitch needs more than one agent with one budget:
  "my grocery bot gets $50/week for groceries; my gift agent must always ask".
* **Decision.**
  * `agents` table: name, kind (`builtin` chat agent, or `external`), **its own API key** (`alw_…`,
    shown once, SHA-256 stored), weekly allowance, auto-pay limit, allowed categories, always-ask,
    status `active | paused | revoked`, last used.
  * Every purchase records `agent_id` / `agent_name`. `evaluatePolicy` checks the user's rules AND
    the agent's allowance, and the allowance can only make a decision **stricter** (paused → block,
    outside its categories → block, over its weekly allowance → block, above its auto-pay limit or
    always-ask → approval). Re-checked inside the purchase transaction.
  * External agents authenticate with their own key, act only for their user, see only their own
    purchases, and can **withdraw** (never approve) their own pending requests
    (`withdraw_purchase_request` MCP tool). Revoking clears the key hash: the key dies immediately.
  * Migration convenience: if `AGENT_API_KEY` is set in `.env`, the **first** account gets it as
    its first agent, so the MCP server and `npm run mcp:demo` / `external-buy` keep working.
* **Why on top of the user's rules, not instead of?** The user's rules are the outer wallet
  limit; agents get slices of it. A misconfigured agent can never exceed what the user allowed.
* **Status.** Accepted.

## D-055 · SQLite → PostgreSQL  ·  *replaces D-007 (SQLite)*

* **Context.** Builder: "use the PostgreSQL that already exists on my machine". Multi-user also
  makes a real server database the better fit, and Render's free disk wiped SQLite on redeploy.
* **Decision.** `pg` (node-postgres) with a pool; schema created on startup (`CREATE TABLE IF NOT
  EXISTS`); money `NUMERIC(12,2)`, times `TIMESTAMPTZ`, JSON as `JSONB`. The synchronous SQLite
  transaction for the budget re-check became a PostgreSQL transaction with a **per-user advisory
  lock** (`pg_advisory_xact_lock(hashtext(user_id))`). `render.yaml` provisions a free Render
  PostgreSQL and injects `DATABASE_URL`. `better-sqlite3` removed.
* **Trade-off.** One more thing to run locally (PostgreSQL), and every data function is now async.
  Old SQLite data isn't migrated (the builder had just cleared it); the saved PayPal wallet is
  re-linked by approving one purchase with "Save my PayPal" ticked.
* **Status.** Accepted.

## D-056 · Per-category approval thresholds ("ask me for electronics over $50")  ·  *extends D-005*

* **Context.** Builder raised auto-pay to $100 but a $46.15 Tile tracker still asked: "always ask:
  electronics" applies at any price. They wanted "electronics over $50" instead.
* **Decision.** New policy field `categoryAskAbove: {category, amount}[]`. In that category,
  purchases above the amount need approval; at or below it the normal auto-pay limit applies.
  The rule parser maps "always ask for X" → `approvalCategories`, "ask for X over $N" →
  `categoryAskAbove` (and removes X from always-ask), "don't ask for X" → removes both. Sanitising
  keeps one threshold per category, and a threshold replaces "always ask" for that category
  (the more specific rule wins). Rules saved before this field existed load with `[]`.
* **Why an array, not a map?** The policy is also an AI structured-output schema; an array of
  objects is supported by every provider's strict JSON mode, an open-keyed map isn't.
* **Status.** Accepted. Verified: engine ($46.15 electronics → ALLOW, $79 → NEEDS_APPROVAL) and
  parser ("Only ask me for electronics over $50" → threshold set, electronics removed from always-ask).

## D-057 · Remote MCP over Streamable HTTP at `/mcp`  ·  *extends D-010*

* **Context.** With stdio MCP, every agent had to run our MCP server on its own machine. Hosted
  agents (and the demo) want "a URL and a key".
* **Decision.** `POST /mcp` on the backend: MCP **Streamable HTTP**, **stateless**
  (`WebStandardStreamableHTTPServerTransport`, `sessionIdGenerator: undefined`, JSON responses),
  authenticated with the agent's own key (`Authorization: Bearer alw_…`). Each request builds a
  fresh MCP server bound to that key's agent.
  * Tool names, descriptions and schemas live once in `src/mcp/tools.ts`; the operations once in
    `src/mcp/ops.ts`. The REST API (`/api/agent/*`), the remote `/mcp` and the local stdio server
    all use them, so they can't drift apart.
  * The dashboard's Agents tab shows the MCP URL (from `RENDER_EXTERNAL_URL` on Render, or
    `PUBLIC_API_URL`) and, when a key is created, a ready-to-paste MCP client config.
* **Why stateless?** No session store, works across restarts/instances, and a revoked or paused
  agent takes effect on the very next request.
* **Status.** Accepted. Verified with the SDK's HTTP client: wrong key rejected; 5 tools listed;
  status shows the agent; casino → BLOCKED; withdraw works; stdio server still works.

## D-059 · Drop redundant category thresholds  ·  *fixes D-056*

* **Context.** "Pay automatically up to $150, ask me above that…" was parsed into
  "ask for coffee/groceries/gifts/… over $150": the model copied the general auto-pay limit into
  every category. Harmless (anything over $150 already asks) but confusing in the UI.
* **Decision.** (1) Deterministic: `sanitizePolicy` drops any threshold ≥ the auto-pay limit (it
  can never change a decision), and rules are sanitised on read as well as on save, so already
  saved rules display cleanly. (2) Prompt: thresholds only when the user names a category *and*
  its own amount; never copy the general limit.
* **Status.** Accepted. Verified: the saved rules clean up; "electronics over $50" is kept; the same
  sentence re-parsed gives no thresholds.

## D-061 · Parental controls: children as allowance holders who log in  ·  *builds on D-053, D-054*

* **Context.** "Give a kid an allowance with rules" is the same problem as "give an AI agent an
  allowance with rules", and a story everyone understands.
* **Decision.** A child is an `agents` row with `kind = 'child'` plus a **username + password** the
  parent picks (`login_name`, scrypt `password_hash`; added with `ADD COLUMN IF NOT EXISTS`).
  * **Login:** the same login form; no "@" = a child's username. The child's session row carries
    `agent_id`, so the child acts *inside the parent's account*: the parent's rules and PayPal, the
    child's own allowance. `GET /api/auth/me` → `{ role: "owner" | "child", child }`; a child never
    sees the parent's email.
  * **Two middlewares:** `requireMember` (parent or child: chat, Allowance Checkout, `/api/kid`) and
    `requireUser` (parent only: rules, wallet, agents, ledger, approvals, refunds → 403 for a child).
  * **A child always has a weekly allowance** (enforced on create and edit). Auto-pay limit,
    allowed categories and "always ask" work as for agents. Parents can pause, reset the password
    (logs the child out everywhere) or remove the child (login freed, sessions deleted, history kept).
  * **Kid-safe check** (`lib/child-safety.ts`): a new pipeline step for children only, after the
    allowance step. Deterministic keyword screen for alcohol, tobacco/vaping, cannabis, gambling,
    weapons and adult content (plus the gambling category). **Can't be turned off by any rule.**
    "Root beer" and "ginger beer" are allowed.
  * **Chat for kids:** same agent loop with an extra system prompt (simple words, never suggest
    age-restricted items, PENDING_APPROVAL = "sent to your parent", no approval link). A child's
    `get_spending_status` shows only their allowance; `list_recent_transactions` only their own;
    their chats are stored under a separate key.
  * **Kid home:** allowance meter, "My rules" in plain words, the shopping helper, "My purchases"
    with "Cancel this request" for pending ones. Checkout: a child buys only as themselves.
* **Why not separate user accounts for kids?** PayPal accounts are 18+, and the parent must stay
  the payer and the approver. Modelling the child as an allowance holder reuses the whole pipeline
  (budget re-check under the advisory lock, timeline, audit) with no new money paths. We store a
  first name and username only: no email or birthday (data minimisation for minors).
* **Bug fixed along the way:** `AgentLimits.partial()` re-applied the defaults, so **Pause/Resume
  (which sends only `status`) wiped the agent's limits**. PATCH now uses `AgentPatch` (all fields
  optional, no defaults).
* **Status.** Accepted. Verified via the API with a throwaway family (deleted afterwards): $8 LEGO →
  approval (no wallet) with "Waiting for a parent"; $22 → over the child's $10 auto-pay → approval;
  beer → BLOCKED by the kid-safe check; root beer → passes the check; child gets 403 on rules,
  wallet, ledger, agents and approvals; child withdraws own request; pause keeps limits and blocks;
  password reset kills the old session; kid chat refuses "beer and a vape" and reports their own
  allowance.

## D-060 · Demo storefront "Brew & Co." with "Pay with Allowance"  ·  *builds on D-051 (quotes)*

* **Context.** Judges should *see* how a real store would integrate, not just an API.
* **Decision.** A demo merchant with its own look:
  * `/store`: product grid; each product has a **Pay with Allowance** button. The store's server
    side (`/api/store/*`, `src/store/brew.ts`) owns the catalog and prices and creates a
    **checkout quote** (the store sets the price, as in D-051), then redirects to
  * `/checkout/[quoteId]` (**Allowance Checkout**, login required): the user picks **which agent is
    buying** and confirms what it was asked to buy; the purchase runs the normal pipeline with
    `source: "store"`, and the page shows the **decision timeline** (D-058), then auto-pay,
    "Review & approve in PayPal" (the approval page offers a way back), or a decline.
  * `/store/order/[quoteId]`: the store's order page polls what Allowance decided (status, amount,
    agent name; no buyer details).
  * The store page also documents the **agent path**: list products → create quote → MCP
    `request_purchase(product_id = quoteId)`.
* **Why inside this repo?** One deploy, no extra keys: the store's server code calls `createQuote`
  directly instead of `/api/merchant/quotes`, but it is the same contract a real store would use.
  Payments still settle to the one sandbox merchant (D-009); a real store would be paid directly
  via PayPal multiparty onboarding.
* **Also:** `GET /mcp` now answers 405 "use POST" instead of opening an empty event stream (it
  confused manual testing in an HTTP client).
* **Status.** Accepted. Verified end to end with a throwaway account (deleted afterwards):
  $34 beans → PENDING_APPROVAL (over $25) with a full timeline; $999 espresso machine → BLOCKED
  (cap + budget); the store's order page reflects both; checkout requires login.

## D-058 · Decision timeline per purchase

* **Context.** The safety story was hidden in a list of reason strings.
* **Decision.** The pipeline records each step it ran as `checks: {step, label, outcome, detail}[]`
  (new `transactions.checks` JSONB, added with `ADD COLUMN IF NOT EXISTS`): price verified (and
  where the price came from) → your rules → the agent's allowance → prompt-injection screen →
  saved PayPal → AI risk check → final budget check → decision. `evaluatePolicy` now also returns
  the user-rules and agent-allowance results separately. The UI adds a live **PayPal** step from
  the purchase status (paid / approved / refunded / withdrawn / failed) and shows the timeline in
  the ledger and on the approval page. Older purchases fall back to the reason list.
* **Status.** Accepted. Verified on a blocked (casino) and an auto-paid (2× tea) purchase.

## D-062 · A lost PayPal response is "unknown", never "failed"  ·  *fixes D-020*

* **Context.** Audit before submission. `autoPay` caught every error and marked the purchase `FAILED`,
  and the agent then says "nothing was charged". On a timeout or dropped connection after PayPal
  captured, that statement is false, and the budget is released for money that actually moved. Also,
  `fetch` had no timeout, and an HTML 502 crashed `JSON.parse` and hid the real status.
* **Decision.** The PayPal client has a 20 s timeout and retries network errors and 5xx, but only for
  reads and for writes carrying a `PayPal-Request-Id`. If it's still unknown, the row stays `PROCESSING`
  (holding budget), and a one-minute sweep re-sends the same id. It stops at 3 hours, well inside
  PayPal's idempotency window: past that a retry could charge twice, so a person has to look.
  Webhooks now verify the raw body (re-serializing can break a genuine signature), turn auto-pay off
  on `VAULT.PAYMENT-TOKEN.DELETED`, and pause the agent on `CUSTOMER.DISPUTE.CREATED`.
* **Status.** Accepted. Tested against a fake PayPal that drops the connection after charging: exactly one charge.
  Webhook handling for those two events is tested with simulated events, not yet from PayPal itself.

## D-063 · The injection screen reads every seller-written field  ·  *fixes D-035*

* **Context.** Only `description` was screened, so moving the same text to the product name or the
  store name got through, and zero-width characters beat the regexes.
* **Decision.** Screen name, description and merchant. Normalize first (NFKC, strip format characters).
* **Limit.** It is still pattern matching and new phrasings can pass. It is one layer, documented as such.
* **Status.** Accepted.

## D-064 · Velocity guard: retries and splitting are enforced, not requested

* **Context.** The agent's prompt said "don't split a purchase or retry", but nothing enforced it. An LLM that
  repeats a tool call would pay twice, and ten $20 purchases passed a $25 auto-pay limit one by one.
* **Decision.** A deterministic step: the same product by the same agent within 10 minutes, auto-payments at one
  merchant adding up past the auto-pay limit within an hour, or 5+ auto-payments within 10 minutes all
  need approval. Checked before the AI (to save a call) and again under the lock (for races). It only
  ever asks, never blocks, so a false positive costs one tap. Purchases a human approved don't count.
* **Also fixed.** The final check ignored `NEEDS_APPROVAL`: turning on "always ask" during the AI check still auto-paid.
  It now re-reads rules on the transaction's own client. Using the pool there could deadlock, because the
  advisory lock can queue every pooled connection. And the first reason on a held purchase now says why
  it was held, instead of "fits the budget".
* **Status.** Accepted.

## D-065 · The Attack Lab

* **Context.** Every project claims to be safe. Ours can be shown, live, and the same scenarios guard against regressions.
* **Decision.** `lib/redteam.ts` runs each attack through the real `requestPurchase` in a throwaway account, deleted
  afterwards. Two internal options that no route or MCP tool passes: `simulatePayment` (PayPal is never
  called) and `assessRisk` (the reviewer is rigged to approve everything on "code" attacks, so the
  deterministic layers are shown to hold with the model fully fooled). Served as `/lab`, `npm run redteam` and in `npm test`.
* **Why not run on the user's account?** A failed defence would touch real money and a real ledger.
* **Verified.** Disabling a defence makes the matching attack fail: velocity guard, field screening and the final check each tried.
* **Status.** Accepted.

## D-066 · Spending Explorer on AG Grid

* **Context.** AG Grid is the largest sponsor track, and a trust product needs a real audit surface; the side-panel list stops at 50 rows.
* **Decision.** AG Grid Community, themed from the app's CSS variables, so one theme covers light and dark.
  *Ask in English:* the model returns a Zod-validated view that drives the grid's external filter and sort. It gets column names
  and the user's agent names, never a transaction, so a seller's text can't reach it and it can't misreport a number.
  *Verify with PayPal:* `GET /v2/payments/captures/{id}` per row, compared on amount and status, read-only.
* **Chart?** No: the question is "which purchases", so a table plus three totals reads better than a chart.
* **Status.** Accepted. The grid and verify flow are checked in a browser and with fake PayPal captures; real sandbox captures still to be tried.

## D-067 · One-click demo accounts  ·  *complements D-053*

* **Context.** A login wall, an empty ledger and a PayPal setup are too much to ask of a judge with many projects to get through.
* **Decision.** Logged-out visitors get a landing page; `POST /api/demo/start` creates a populated account (rules, two
  agents, a child, history). Recent rows come from the real pipeline; older rows have `source = 'sample'` and are labelled, with
  no PayPal ids, and sit outside the budget window. Deleted after 24 hours, with no usable password, and rate limited.
* **Shared wallet.** `DEMO_VAULT_ID` lets visitors see auto-pay with no PayPal login. Everyone shares it, so the demo refuses to run
  unless the PayPal base is the sandbox, and Disconnect doesn't revoke it at PayPal.
* **Status.** Accepted.

## D-068 · Rule advisor: decisions become suggested rules

* **Decision.** Code counts approvals, rejections and refunds per category and proposes changes; tightening is listed first. AI only
  writes a sentence on the trade-off, from counts alone, and the facts stand without it. Apply re-derives the proposal on
  the server, so a client can only apply what the evidence supports now. Nothing changes without a click.
* **Status.** Accepted.

## D-069 · Render: no rootDir  ·  *fixes D-042*

* **Context.** Render's docs: files outside a service's root directory aren't available at build time or at runtime. The Blueprint
  set `rootDir: backend` with `cd .. && npm ci`, but this is a workspace with one root `node_modules`.
* **Decision.** No `rootDir`; workspace commands from the root; `npm ci --include=dev`, since builds need tsup and TypeScript; `buildFilter`
  so each service redeploys only when its files change.
* **Status.** Accepted, not yet deployed.

## D-070 · Which sponsors, and why

* **Used:** AG Grid (D-066), Channel3 (D-050), Render (D-069). **Spec only:** `docs/openapi.yaml` for Postman and APIMatic, usable by anyone without an account here.
* **Left out on purpose:** Bryntum (no scheduling in this product, and a calendar would be decoration), Elastic (a 30-product demo catalog doesn't need
  vector search, and Channel3 already does search), Kernel and Astropods (would add a key judges need, with no change to the trust story),
  Zapier (approval alerts are genuinely useful, and the next thing to add, but no prize track was listed).
* **Status.** Accepted.

## D-071 · Dashboard layout and contrast  ·  *fixes D-068's side effect*

* **Context.** Builder's screenshot: rule suggestions (D-068) made the rules card taller, and the right column had a fixed
  height, so Purchases shrank to one cut-off row. Measured: 113px and no complete row at 1024×768. Chip labels were as low as 2.5:1,
  and white text sat on light accents in dark mode.
* **Decision.** The column height no longer depends on the window: Purchases is always 32rem and scrolls inside itself, and the chat stays in view
  as the page scrolls. Suggestions and the long rule text start collapsed; the demo steps can be hidden. The header stays on one row from
  laptop width. Colours: chip labels lose their opacity, dark panels separate from each other, and a new `--on-accent` token
  sets text on solid accents per theme.
* **Why collapse suggestions?** They are useful but occasional, and the ledger is what people watch.
* **Status.** Accepted. Measured at 5 window sizes in both themes: Purchases 512px at each, no sideways scroll, every sampled colour at least 4.5:1.


## D-072 · A refused saved PayPal asks the owner, instead of failing  ·  *builds on D-062*

* **Context.** Auto-pay used one saved PayPal (Vault token). If PayPal refused it (token revoked or expired, funding declined), the purchase ended `FAILED`.
  The hosted demo shares one token across every visitor, so one dead token would have broken auto-pay for everyone.
* **Decision.** A *definite* refusal of the saved PayPal moves the purchase to `PENDING_APPROVAL` with the reason first, a "Saved PayPal" step on its timeline,
  and an `AUTOPAY_FALLBACK` audit entry. Covered: a declined charge, and PayPal saying the token is gone (404, `INVALID_RESOURCE_ID`, vault errors).
  When the token itself is gone, the wallet is also set to disconnected, so the next purchase asks straight away.
* **What is not covered, on purpose.** Timeouts, network errors and 5xx stay `PROCESSING` (the money may have moved, D-062). A 401, or a 400 about our own request,
  stays `FAILED`: asking a person would not fix it.
* **Why safe.** Nothing is charged on a definite 4xx at order creation, or on a declined capture. The approval page makes a new order with its own request id.
* **Status.** Accepted. Tests: decline, revoked token (wallet turns off, next purchase asks, no PayPal call), and an unrelated 400 still failing.

## D-073 · AG Charts beside the AG Grid ledger, and a Postman collection

* **Decision.** The Explorer gets a 14-day stacked column chart (paid, waiting, stopped) on AG Charts Community. It plots the grid's *visible* rows, so a question or filter redraws
  both. Chart colours are read from the app's tokens and refreshed when the theme flips, because a canvas can't read CSS variables.
* **Postman.** `docs/postman/` is generated from `openapi.yaml`, then given real example bodies, folder-level auth and tests. Running it with `newman` found two real problems:
  generated requests carried their own unset `{{bearerToken}}`, and the spec had an unquoted comma that cut off two field descriptions. Both fixed.
* **APIMatic.** The spec was imported and audited: 68 for the first version, 54 for a hand-edited rewrite, and **99** for version 1.3.0, which was rebuilt rule by rule from APIMatic's own findings.
  APIMatic then set up a portal project in `src/` (the spec, `apimatic.json`, pages, and navigation with SDK and Context Plugin tabs). Not yet verified: that the portal was built and published, that SDKs were downloaded, or that a Context Plugin was installed and used. The docs claim only what is above.
* **Status.** Accepted.

## D-074 · Checks from the APIMatic Context Plugin  ·  *changes D-072, fixes refunds*

* **Context.** The plugin (docs in `docs/APIMATIC.md`) was asked six questions about the PayPal calls we make.
* **Decision, auto-pay.** The plugin could not confirm the error codes for a revoked token, so D-072's guessed codes stay as a first filter, and at order creation any 422 now asks the owner (PayPal documents 422 as a business-rule refusal: nothing is charged).
  **Not at capture:** a 422 there can mean "order already captured", and asking the owner to pay again could charge twice. A test proves that path stays `FAILED`.
* **Decision, refunds.** PayPal can accept a refund and report it `FAILED` or `CANCELLED`. That no longer marks the purchase `REFUNDED`: it stays `PAID`, an audit entry is written, and the owner is told. Refunds also send `custom_id` (our transaction id).
* **Left alone on purpose.** `storedCredential` (MERCHANT, SUBSEQUENT) on vaulted orders: not mandatory, auto-pay is live-verified without it, and it can't be retested here.
* **Not covered by the plugin.** Webhook signature verification and event names.
* **Status.** Accepted. 84 tests pass.

## D-075 · Approval alerts, Zapier-compatible  ·  *amends D-070*

* **Context.** An approval request was only visible if the owner opened the dashboard, which is the weakest point of "ask a human". D-070 named Zapier alerts as the next useful addition.
* **Decision.** Each owner can save one webhook address. Allowance posts JSON to it when a person is needed: a purchase waits for approval (including when a refused saved PayPal sends it there, D-072) or a payment fails.
  Blocked purchases and the Attack Lab stay quiet. The body has a `text` line (Slack shows it) and structured fields (Zapier receives them all).
* **Why a webhook and not a Zapier SDK.** It needs no account here and works with Zapier, Slack, Make or anything else.
* **Safety.** The server calls a URL a user typed, so: https only, no credentials in the address, no private or reserved ranges, the address re-checked **at connection time** (so a name that changes its answer can't slip through), no redirects, 5-second timeout,
  and the saved URL is never returned, only its host (hook URLs carry a secret). A test proves the connect-time check: with it switched off, that test fails.
* **Not built, on purpose.** Bryntum (decoration, trial licence), Elastic (a 30-product catalog and a ledger don't need it), Kernel (Allowance never drives real checkouts), Astropods (a runtime for hosting agents; Allowance is the trust layer, and Render hosts it).
* **Not verified.** Delivery to a live Zapier account. It was tested against a local receiver.
* **Status.** Accepted. 97 tests.

## D-076 · Demo accounts start fresh  ·  *changes D-067*

* **Context.** Every new demo account came pre-filled with 20 sample purchases and three live ones (a pending $79 earbuds
  purchase among them). Opening the demo in a new browser looked like someone else's history, not a fresh start.
* **Decision.** A demo account still gets the default rules, the built-in chat agent, two example agents and a child login, but
  no purchases. The visitor creates every row themselves. The rule advisor has no suggestions until there are decisions to learn from.
* **Status.** Accepted.
