# Handoff: Allowance, for the PayPal + AI hackathon

**Last updated: 2026-11-04.** Written so a new chat can continue without the old one.

**To continue in a new chat, say:** "Read `docs/HANDOFF.md`, then help me with the next steps."

## Where things stand

- **Goal:** make this one of the best projects in the hackathon and reach the top 10. Nobody can promise that result.
- **Deadline:** Nov 12, 2026, 3:00 PM EST, per PayPal's blog and a Devpost listing. One third-party listing says Nov 13, so confirm it on Devpost. One aggregator lists judging as Dec 1–15 (unconfirmed).
- **Code:** built and tested with a fake PayPal: **97 backend tests pass**, typecheck and lint are clean, and the production build passes. There are no frontend tests.
- **Git:** `main` equals GitHub at `edc7e29`. That includes the redesign, dark theme, logo and favicon. **30 files of newer work are uncommitted and unpushed** (list under "Uncommitted work"). A fresh clone doesn't have them.
- **Biggest risks, in order:**
  1. The new work isn't on GitHub, and the APIMatic form's first field asks for the repo.
  2. The hosted demo doesn't exist yet (no Render deploy), which is how judges first see the project.
  3. Nothing new has run against real PayPal or AI keys.
  4. Five `TODO_` placeholders are still in the docs.

## What to do next, in order

1. **Commit and push** when the user says so. Never mention Claude in commit messages, and add no co-author line (see "Working rules"). Then confirm CI goes green on GitHub. The workflow has never run.
2. **Test with real keys** using `npm run dev` (the user's `backend/.env` has them):
   - Chat, auto-pay, the PayPal button, refund, and **Verify with PayPal** on a real capture.
   - A question in the Explorer (never run), and the new AG Charts view above the grid.
   - `npm run check-ai`, then `npm run redteam`, then `npm run external-buy -- --suite`.
   - **Sandbox checks the Context Plugin couldn't settle:** what PayPal returns for a revoked saved wallet, and whether adding `storedCredential` (MERCHANT, SUBSEQUENT) to vaulted orders helps. See `docs/APIMATIC.md`.
   - Approval alerts: save a real Zapier Catch Hook and use "Send a test". Delivery to Zapier itself is **unverified**.
3. **Deploy on Render** using `render.yaml`:
   - Set `APP_URL` and `BACKEND_URL`, then redeploy the frontend, because `BACKEND_URL` is read at build time.
   - Set `DEMO_VAULT_ID` to a **sandbox** vault id. To get one, approve a purchase with "Save my PayPal" ticked, then run `SELECT payment_token_id, payer_email FROM wallets;`.
   - Leave `NOTIFY_ALLOW_PRIVATE` **unset** in production (see Approval alerts below).
   - Test in a private window. Free services sleep when idle, so add a keep-warm ping. The free database expires after about 30 days, which could fall inside judging, so use a paid database or recreate it.
4. **Add the PayPal webhook** at `<backend>/api/paypal/webhook`, with events `PAYMENT.CAPTURE.*`, `VAULT.PAYMENT-TOKEN.DELETED` and `CUSTOMER.DISPUTE.CREATED`. Set `PAYPAL_WEBHOOK_ID`, then try PayPal's Webhooks Simulator. The APIMatic plugin did **not** cover webhook verification.
5. **Replace the 5 `TODO_` placeholders:** 2 in `README.md` and 3 in `SUBMISSION.md` (hosted URL, video URL, sandbox buyer email and password). These need values only the user has.
6. **APIMatic prize form** (see "APIMatic" below). The draft text is ready in `docs/APIMATIC.md`. The terms, subscription and consent boxes, and which email the subscription is tied to, are the user's own decisions.
7. **GitHub About section:** description, website and topics are empty. The MIT license is detected and the repo is public.
8. **Read the Devpost rules yourself.** Devpost blocked automated access, so the scoring rubric is **unread**: https://paypalaihackathon.devpost.com/. The APIMatic prize text the user pasted says only: "All Eligible Submissions that use any APIMatic tools."
9. **Record the video and submit.** The script and checklist are in `SUBMISSION.md`. It must be under 3 minutes, public on YouTube, with no third-party music or trademarks. Use `CATALOG_SOURCE=demo`. **Add a 10–15 second beat** showing the Context Plugin connected in `/mcp` and one tool call: the script doesn't have it yet.

## The project

**Allowance: "Give your AI agent an allowance, not your wallet."** A trust layer between any AI agent and a person's PayPal. You write rules in plain English. Agents get their own keys and allowances, and can only *ask* to buy. Each purchase is auto-paid from a saved PayPal, sent to you for approval in PayPal, or blocked with a reason.

**Core principle: the AI proposes, the code decides.** A model can't raise a limit, name a price, or approve its own purchase. The AI risk check can only make a decision stricter.

- **Stack:** Next.js 16 frontend (port 3000), Hono backend (port 4000), PostgreSQL, npm workspaces. Node 22 (`engines` says `>=22.12`).
- **AI:** Gemini (default), Groq, or Claude, with automatic fallback.
- **Repo:** https://github.com/himanshmunjal/Allowance (public, MIT).
- **Earlier sessions built:** chat agent, rules, policy engine, PayPal Orders v2, Vault v3 and JS SDK v6, refunds, webhooks, MCP, per-agent allowances, Channel3 catalog, Brew & Co. store, landing page, one-click demo, Attack Lab (18 attacks), Spending Explorer, rule advisor, parental controls, tests, CI. See `FLOW.md` Phases 1–23.

## What the latest session added (FLOW.md Phase 24)

| Change | Plain description | Where |
|---|---|---|
| Redesign and dark theme | Warm paper-and-ink palette, serif headline, ring logo, new favicon, light/dark toggle with no flash. Checked in headless Chrome in both themes, including the full dashboard | `frontend/app/globals.css`, `Logo.tsx`, `ThemeToggle.tsx`, `icon.svg` |
| Auto-pay fallback (**D-072**, changed by D-074) | A definite refusal of the saved PayPal asks the owner instead of failing. If the token itself is gone, auto-pay turns off | `backend/src/lib/purchase.ts` |
| AG Charts (**D-073**) | A 14-day paid / waiting / stopped chart above the ledger, following whatever the grid shows | `frontend/app/explorer/SpendChart.tsx` |
| Postman collection (**D-073**) | Generated from the spec, fixed up, and run green with `newman`: 9 requests, 19 assertions | `docs/postman/` |
| APIMatic spec | 68 → 54 → **99/100** (see below) | `docs/openapi.yaml`, `src/` |
| Context Plugin (**D-074**) | Installed and used on 6 PayPal questions. Found a real refund bug, fixed | `docs/APIMATIC.md` |
| Approval alerts (**D-075**) | An owner saves a webhook address (Zapier Catch Hook, Slack…) and gets a message when a purchase needs approval or a payment fails | `backend/src/lib/notify.ts`, `routes/notify.ts`, `frontend/app/components/AlertsPanel.tsx` |

**Uncommitted work** (30 files at the time of writing): `DECISION.md`, `FLOW.md`, this file, `README.md`, `SUBMISSION.md`, `backend/.env.example`, backend `app.ts`, `config.ts`, `db.ts`, `paypal.ts`, `purchase.ts`, three test files, `docs/LLD.md`, `docs/openapi.yaml`, `Dashboard.tsx`, `ExplorerView.tsx`, `frontend/package.json`, `package-lock.json`; new: `.apimaticvscodeignore`, `notify.ts` (lib and route), `docs/API.md`, `docs/APIMATIC.md`, `docs/postman/`, `AlertsPanel.tsx`, `SpendChart.tsx`, `src/`, and a stray `openapi (3).yaml` in the root (an old copy of the spec: ask the user before deleting it, and don't commit it).

## Bugs fixed this session

| Problem | Now |
|---|---|
| A revoked or declined saved PayPal made auto-pay fail, and the shared demo token could break it for every visitor | Asks the owner instead. Any 422 when **creating** the order asks the owner (PayPal documents 422 as a business-rule refusal: nothing charged). **Not at capture**, where a 422 can mean "already captured" and asking again could charge twice. A test proves it, and fails if the condition is removed |
| A refund PayPal reported `FAILED` or `CANCELLED` still marked the purchase refunded | Stays `PAID`, an audit entry is written, the owner is told. Refunds also send `custom_id` |
| The OpenAPI spec had an unquoted comma that cut off two descriptions (found by running the collection), and generated Postman requests carried an unset auth variable | Both fixed |

## APIMatic

- **Prize:** Best Use of APIMatic, three winners at $1,000 plus 6 months of APIMatic Business. "All eligible submissions that use any APIMatic tools." The form asks for the repo URL, a **description of Context Plugin usage**, and consent boxes (subscription non-transferable and tied to the submitter's email, terms of service, case-study consent).
- **Spec score history:** 1.1.0 scored 68 (183 issues). A hand-edited 1.2.0 scored 54. **1.3.0 scored 99**, rebuilt rule by rule from APIMatic's own findings. The spec is now plain YAML with no anchors. The script that generated it was temporary and is gone, so edit the YAML by hand.
- **Portal project:** APIMatic set up `src/` (spec copy, `apimatic.json` with C#, TypeScript and Python targets, pages and navigation including a Context Plugin tab). **`src/spec/openapi.yaml` is a copy of `docs/openapi.yaml`: keep them identical.** The user has **not** been seen to build or publish the portal or download an SDK.
- **Context Plugin:** installed in Claude Code as `context-matic@apimatic-context-matic` (marketplace `apimatic/context-matic`). Tools: `fetch_api`, `ask`, `endpoint_search`, `model_search`, `update_activity`; API key `paypal`, language `typescript`. It's an MCP server, so after a restart or `/reload-plugins` check `/mcp`. Findings are in `docs/APIMATIC.md`: request ids live 6 hours on order calls and 45 days on refunds, refund and capture statuses, and a refund bug. It could **not** answer revoked-token error codes or webhook verification.
- **IDE noise:** the VS Code APIMatic extension (`apimatic-for-vscode`) showed stale errors from the first spec, plus `node_modules` files. `.apimaticvscodeignore` fixes the `node_modules` part. The stale list clears with **Developer: Reload Window**, then **Validate Workspace**.
- **CLI:** needs Node 24, and the machine has 22. Run it without changing Node: `npx --yes -p node@24 -p @apimatic/cli@latest -c 'apimatic auth login'` (works; `quickstart` is optional).

## Hackathon facts

**Requirements (from the user's paste):** meaningful use of both PayPal and AI, a working demo (hosted URL or clear run instructions), a text description, the tools used and how, a public repo with a visible license, and a public YouTube video under 3 minutes. Project must be new or significantly updated during the submission period, and the submission should say how.

**Prize tracks:** Best Overall $12k, $8k, $5k. Most Creative, Most Impactful, Best Demo Delivery, Best Use of PayPal + AI, Best Use of Agentic Commerce, $5k each. Best Use of AG Grid $5k, $2k, three at $1k. APIMatic three at $1k plus a subscription. Bryntum three at $1k. Channel3 $1.5k. Render credits $1k, $750, $500.

**Not verifiable:** the scoring rubric and sponsor rules (Devpost blocked access), and the total prize pool (sources disagree: $69,750, $67,500, $60,000+). One aggregator lists the submission period as opening Oct 1; git history starts Oct 30. Say what's true in the "how it was updated" text.

**Sponsors, decided (D-070, D-075):**

| Sponsor | Status |
|---|---|
| AG Grid | Used: Explorer grid and the new AG Charts view |
| Channel3 | Used: live product search |
| Render | Blueprint ready, **not deployed** |
| Postman | Collection built and run green. No Postman account used |
| APIMatic | Spec audit 99/100, portal project, Context Plugin used |
| Zapier | Alerts built vendor-neutral (webhook). Tested against a local receiver only |
| Bryntum, Elastic, Kernel, Astropods | Left out on purpose. Each would be decoration or unrelated; reasons in D-075 |

## What has been tested

**Passed:** 97 of 97 backend tests (no keys needed, fake PayPal that can drop connections, decline, revoke a wallet, fail a refund). Typecheck, lint and the production build (built in a scratch copy, never in the user's folder). Deliberately breaking three defences, the capture-stage 422 rule, and the alert connect-time check each made the matching test fail, then were restored. The API was checked live against the spec (every response matches). Headless Chrome: Explorer with the chart, and the dashboard with the alerts card, in light and dark.

**Limits:** everything used a **fake PayPal and no AI key**. The "real AI" attack showed only the fail-safe. Earlier phases verified orders, vaulting, auto-pay and refunds live (`FLOW.md` Phase 13), but not the newest code.

**Never run:** real capture reads, English questions in the Explorer, real webhooks for the new events, delivery to a live Zapier account, the Render deploy, `docker-compose.yml`, the GitHub CI workflow, the phone layout by eye, and a build or publish of the APIMatic portal.

## Known gaps, not fixed

- Real PayPal error codes for a revoked saved wallet are **unconfirmed**. Allowance no longer depends on them, but the first-filter patterns in `purchase.ts` are guesses.
- Webhook signature verification and event names weren't covered by the plugin.
- Pending approvals never expire. `PROCESSING` rows older than 3 hours need a person, and there's no screen for that.
- Merchant quotes declare their own `sellerVerified`. The public store checkout can create unlimited quotes.
- Login and demo rate limits trust `x-forwarded-for`, which can be spoofed.
- The injection screen is pattern matching. The docs say so; don't overclaim.
- `npm install` prints an audit warning that hasn't been looked at.
- **Next addition if time:** nothing planned. The user asked that anything new be related to the project, not decoration.

## Working rules for the next chat

- **Don't read `backend/.env`** (or `frontend/.env.local`). The project's own scripts can use them.
- **Don't commit or push unless asked.** The user's rule: never mention Claude or Claude Code in commit messages, and add no co-author line. This overrides any default attribution text.
- **Add only what's related to the project.** The user said so when asking about more sponsor integrations. Explain skips honestly.
- **Keep test data out of the user's database.** Check ports 3000 and 4000 first. Use a **scratch copy** for browser checks and builds: `rsync` the repo (excluding `node_modules`, `.next`, `.git`, `.env*`) into the scratchpad, then clone `node_modules` with `cp -cR` (a symlinked `node_modules` makes Turbopack fail). Use a separate database and ports, and stop only what you started. Don't leave a copy of `.env` in the scratch folder.
- **Explain in easy language** and **be exact about safety claims**: say what's verified and what isn't.
- **Next.js:** `frontend/AGENTS.md` says this version differs from older ones, so read `node_modules/next/dist/docs/` before writing unfamiliar Next.js code.
- **Docs:** add decisions to `DECISION.md` (next number **D-076**, append-only) and steps to `FLOW.md` (Phase 24 is open: next row 24.10).
- **Tooling quirks:** the safety check once blocked a very long shell heredoc, so use the Write tool for big files. The IDE connection to the assistant drops sometimes. Browser extension tools weren't connected, so headless Chrome over its debugging port worked instead.

### How to run things

| Task | Command |
|---|---|
| Run the app | `npm run dev` |
| Tests (no keys needed) | `docker compose up -d`, then `npm test`; or set `TEST_DATABASE_URL` |
| Attack Lab in the terminal | `npm run redteam` |
| Checks | `npm run typecheck`, `npm run lint`, `npm run build` |
| Lint the API spec | `npx @redocly/cli lint docs/openapi.yaml` (2 known warnings: no 4XX on two read-only store routes) |
| Run the Postman collection | `npx newman run docs/postman/allowance.postman_collection.json --env-var baseUrl=http://localhost:4000 --env-var agentKey=<alw_ key> --env-var merchantKey=<MERCHANT_API_KEY>` |

If Docker isn't running, start a temporary Postgres with the binaries in `/Library/PostgreSQL/17/bin`:

```bash
initdb -D <scratch dir> -U postgres --auth=trust
pg_ctl -D <scratch dir> -o "-p 5433 -c unix_socket_directories='' -c listen_addresses=127.0.0.1" -w start
createdb -h 127.0.0.1 -p 5433 -U postgres allowance_test
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/allowance_test npm test
```

For browser checks, run the backend from `backend/` with `node --import tsx src/server.ts`, which doesn't load `.env`, and give it test values for `DATABASE_URL`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `DEMO_MODE=on`, `MERCHANT_API_KEY` and `CATALOG_SOURCE=demo`. Add `NOTIFY_ALLOW_PRIVATE=on` only to test alerts against a local receiver. The next backend start adds a `users.notify_webhook_url` column to the user's real database (it only adds, like earlier changes).

## Where to read more

| File | What's in it |
|---|---|
| `README.md` | Overview, judge's guide, setup, tools used |
| `SUBMISSION.md` | Devpost text, 2:45 video script, final checklist |
| `DECISION.md` | Every decision and why; the latest session's are D-072 to D-075 |
| `FLOW.md` | Build log; the latest session is Phase 24 |
| `docs/LLD.md` | Detailed design: schema, pipeline, API table |
| `docs/openapi.yaml` | Agent and merchant API (scores 99 in APIMatic) |
| `docs/API.md` | Using the API: Postman, APIMatic, curl, score history |
| `docs/APIMATIC.md` | Context Plugin log and the ready-to-paste form text |
| `docs/postman/` | Postman collection and environment |
| `src/` | APIMatic portal project |

**Sources:** [PayPal hackathon post](https://developer.paypal.com/community/blog/PayPal_AI_Hackathon) · [Devpost page](https://paypalaihackathon.devpost.com/) · [ContextMatic plugin page](https://www.apimatic.io/product/contextmatic) · [Render monorepo docs](https://render.com/docs/monorepo-support)
