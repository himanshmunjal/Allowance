# Handoff: Allowance, for the PayPal + AI hackathon

**Last updated: 2026-11-04.** Written so a new chat can continue without the old one.

**To continue in a new chat, say:** "Read `docs/HANDOFF.md`, then help me with the next steps."

## Where things stand

- **Goal:** make this one of the best projects in the hackathon and reach the top 10. Nobody can promise that result.
- **Deadline:** Nov 12, 2026, 3:00 PM EST, according to a Devpost listing. One third-party listing says Nov 13, so confirm it on Devpost.
- **Code:** the features below are built, and tests pass with a fake PayPal.
- **Biggest risk:** **this work is committed locally but not pushed.** It's still only on this computer, and GitHub stops at `876930d`, so a fresh clone wouldn't have it. That includes the parental controls.
- **Not done yet:** a full test with real keys, the Render deploy, and the demo video.

## What to do next, in order

1. **Push to GitHub.** The user asked for commits without a push, so don't push until they say so. The banner's README link and CI both depend on it.
2. **Run a production build:** `npm run build`. It last ran before the dashboard layout fix. It was skipped afterwards to avoid disturbing the user's running dev server, so check that doesn't clash if that server is still up.
3. **Test with real keys** using `npm run dev`:
   - Chat, auto-pay, the PayPal button and refund
   - **Verify with PayPal** on a real capture
   - A question in the Explorer (this code has **never been run**)
   - `npm run check-ai`, then `npm run redteam`, so the AI attack runs on a real model
   - `npm run external-buy -- --suite`, whose results may change because of the new retry and split guard
4. **Deploy on Render** using `render.yaml`:
   - Set `APP_URL` and `BACKEND_URL`, then redeploy the frontend, because `BACKEND_URL` is read at build time.
   - Set `DEMO_VAULT_ID` to a **sandbox** vault id. To get one, approve a purchase with "Save my PayPal" ticked, then run `SELECT payment_token_id, payer_email FROM wallets;`.
   - Test in a private window.
   - Free services sleep when idle, and the free database expires, so check it outlasts judging.
5. **Add the PayPal webhook** to `<backend>/api/paypal/webhook`, with events `PAYMENT.CAPTURE.*`, `VAULT.PAYMENT-TOKEN.DELETED` and `CUSTOMER.DISPUTE.CREATED`. Set `PAYPAL_WEBHOOK_ID`, then try PayPal's Webhooks Simulator.
6. **Replace the `TODO_` placeholders:** 2 lines in `README.md` and 3 in `SUBMISSION.md` (hosted URL, video URL, sandbox buyer login).
7. **Confirm CI passes on GitHub.** The workflow has never run.
8. **Fill in the GitHub About section:** description, website and topics. They're empty; the MIT license is already detected and the repo is public.
9. **Read the Devpost rules yourself.** See "Hackathon facts" below for what couldn't be checked.
10. **Record the video and submit.** The script and checklist are in `SUBMISSION.md`. The video must be under 3 minutes, public on YouTube, with no third-party music or trademarks. Use `CATALOG_SOURCE=demo` when recording, so no real retailer branding appears.

## The project

**Allowance: "Give your AI agent an allowance, not your wallet."** A trust layer between any AI agent and a person's PayPal. You write rules in plain English. Agents get their own keys and allowances, and can only *ask* to buy. Each purchase is auto-paid from a saved PayPal, sent to you for approval in PayPal, or blocked with a reason.

**Core principle: the AI proposes, the code decides.** A model can't raise a limit, name a price, or approve its own purchase. The AI risk check can only make a decision stricter.

- **Stack:** Next.js 16 frontend (port 3000), Hono backend (port 4000), PostgreSQL, npm workspaces.
- **AI:** Gemini (default), Groq, or Claude, with automatic fallback.
- **Repo:** https://github.com/himanshmunjal/Allowance (public, MIT).

**Already there before this chat:** chat agent, plain-English rules, policy engine, PayPal Orders v2, Vault v3 and JS SDK v6, refunds, webhooks, MCP (remote and local), per-agent allowances, Channel3 live catalog, Brew & Co. demo store with "Pay with Allowance", decision timeline, accounts.

## Hackathon facts

**Requirements (from the user's paste):** meaningful use of both PayPal and AI, a working demo (hosted URL or clear run instructions), a text description, the tools used and how, a public repo with a visible license, and a public YouTube video under 3 minutes.

**Prize tracks (from PayPal's blog post):**

| Track | Prizes |
|---|---|
| Best Overall | $12k, $8k, $5k |
| Most Creative, Most Impactful, Best Demo Delivery, Best Use of PayPal + AI, Best Use of Agentic Commerce | $5k each |
| Best Use of AG Grid | $5k, $2k, three at $1k |
| Best Use of APIMatic | three at $1k |
| Best Use of Bryntum | three at $1k |
| Best Use of Channel3 | $1.5k |
| Best Use of Render | Credits: $1k, $750, $500 |

**What couldn't be checked:**
- **Rules and scoring:** Devpost blocked automated access (403), so the scoring rubric and sponsor prize rules are **unread**. The page is https://paypalaihackathon.devpost.com/.
- **Total prize pool:** sources disagree: $69,750 (user's paste), $67,500 (Devpost listing), $60,000+ (PayPal's blog).

**Sponsors, decided (D-070):**
- **Used:** AG Grid, Channel3, Render.
- **Spec only:** `docs/openapi.yaml` can be imported into Postman or APIMatic. No account was used for either.
- **Left out on purpose:** Bryntum (no scheduling in the product), Elastic, Kernel, Astropods.
- **Next useful addition:** Zapier approval alerts. PayPal's blog lists no Zapier prize, so it was skipped.

## What this chat added

| Feature | Plain description | Where |
|---|---|---|
| Landing page | Logged-out visitors see the pitch and "Try the live demo" | `frontend/app/components/Landing.tsx` |
| One-click demo | Throwaway account with rules, 2 agents, a child and labelled sample history. Sandbox only, deleted after 24 hours | `backend/src/lib/demo.ts` |
| Attack Lab | 18 live attacks on the real pipeline in throwaway accounts, with PayPal never called. On 17, the AI reviewer is rigged to approve everything, so the code must hold alone | `backend/src/lib/redteam.ts`, `frontend/app/lab/` |
| Spending Explorer | AG Grid ledger: ask in English, verify against PayPal, export CSV. The model never sees a transaction | `backend/src/lib/explorer.ts`, `frontend/app/explorer/` |
| Rule advisor | Code counts your approvals and rejections and suggests rule changes. AI only explains them. Nothing changes until you click Apply | `backend/src/lib/advisor.ts` |
| Tests | 77 tests, no keys needed, including a fake PayPal that drops the connection after charging | `backend/test/` |
| Project tooling | CI, a Docker database, an OpenAPI spec, submission text and video script | `.github/workflows/ci.yml`, `docker-compose.yml`, `docs/openapi.yaml`, `SUBMISSION.md` |

## What this chat fixed

| Problem | Now |
|---|---|
| A lost PayPal reply was marked "failed, nothing charged", which could be false | Stays `PROCESSING` and retries with the same `PayPal-Request-Id`. The retry sweep stops at 3 hours, then a person must review |
| PayPal calls had no timeout, and an HTML error page crashed parsing | 20-second timeout, safe retries, non-JSON errors handled |
| A repeated AI tool call could pay twice, and splitting got past the auto-pay limit | New retry, split and burst guard in `lib/velocity.ts`. It only ever asks a human |
| Injection screening only read the description | Screens product name, description and store name, and normalizes disguised Unicode |
| "Always ask" turned on mid-purchase was ignored | The final check under the database lock re-reads rules, and the newest rule wins |
| A held purchase's first reason could be "fits the budget" | The reason it was held comes first |
| Webhook signatures were checked on re-serialized text | Checked on the raw body |
| No reaction to disputes or removed consent | A dispute pauses that agent; removing consent in PayPal turns auto-pay off |
| `render.yaml` couldn't work, because `rootDir` hid the root `node_modules` | Removed `rootDir`. **Not deployed yet** |
| Diagram and `docs/LLD.md` were out of date (SQLite, single-user) | Both updated to match the code |
| Dashboard: Purchases squeezed to one row, faint colours (user's screenshot) | Purchases always 512px, chat stays in view, suggestions collapsed, contrast fixed with a new `--on-accent` token |

**Heads-up:** the next backend start adds new columns to the user's real database automatically. The change only adds things. It may already have happened, since the user ran the app after these changes.

## What has been tested

**Passed:**
- 77 of 77 tests, typecheck and lint, last run after the dashboard fix.
- Removing three defences one at a time made the matching attacks fail, so the tests do catch regressions.
- Headless Chrome against the production build: Attack Lab 18 of 18, in light and dark mode. This was before the dashboard fix.
- Dashboard fix, against the dev server: 5 window sizes in both themes, every sampled colour at least 4.5:1, no sideways scroll, and Apply confirmed on the server and after a reload.

**Limits of that testing:**
- It all used a **fake PayPal and no AI key**. The "real AI" attack therefore showed only the fail-safe (asking a human).
- The user's screenshot showed AI-written suggestion text, so a real AI key was working on their machine at that point.
- Earlier project phases verified PayPal orders, vaulting, auto-pay and refunds live (`FLOW.md`, Phase 13), but the new code hasn't had that.

**Never run:** real capture reads, English questions in the Explorer, real webhooks for the two new events, the Render deploy, `docker-compose.yml`, the GitHub CI workflow, and the phone tab fix by eye (only its layout numbers were measured).

## Known gaps, not fixed

Noticed while reading the code. None are urgent for the demo.

- Pending approvals never expire; they only drop out of the 7-day budget window.
- If a saved PayPal token stops working, auto-pay fails instead of falling back to approval.
- `PROCESSING` rows older than 3 hours need a person, and there's no screen for that.
- Merchant quotes declare their own `sellerVerified`.
- The public store checkout can create unlimited quotes.
- Login and demo rate limits trust `x-forwarded-for`, which can be spoofed.
- The injection screen is pattern matching, so new phrasings can get past it. The docs say so; keep it that way and don't overclaim.
- `npm install` printed an audit warning that hasn't been looked at.

**Ideas for later:** Zapier or push approval alerts, multiparty onboarding so real stores get paid, signed receipts a store can verify.

## Working rules for the next chat

- **Don't read `backend/.env`.** An attempt to read it, even with values masked, was denied in this chat. The project's own scripts can use it normally.
- **Don't commit or push unless asked.** The user's instruction: never mention Claude or Claude Code in commit messages, and add no co-author line.
- **Keep test data out of the user's database.** Check ports 3000 and 4000 first, because the user may have dev servers running. Stop only the processes you started.
- **Explain things in easy language.** The user asked for this.
- **Be exact about safety claims.** Say what's verified and what isn't.
- **Next.js:** `frontend/AGENTS.md` says this version differs from older ones, so read `node_modules/next/dist/docs/` before writing unfamiliar Next.js code.
- **Docs:** add new decisions to `DECISION.md` (next number D-072; entries are append-only) and new steps to `FLOW.md`.

### How to run things

| Task | Command |
|---|---|
| Run the app | `npm run dev` |
| Tests (no keys needed) | `docker compose up -d`, then `npm test`; or set `TEST_DATABASE_URL` |
| Attack Lab in the terminal | `npm run redteam` |
| Checks | `npm run typecheck`, `npm run lint`, `npm run build` |

If Docker isn't running, start a temporary Postgres with the binaries in `/Library/PostgreSQL/17/bin`:

```bash
initdb -D <scratch dir> -U postgres --auth=trust
pg_ctl -D <scratch dir> -o "-p 5433 -c unix_socket_directories='' -c listen_addresses=127.0.0.1" -w start
createdb -h 127.0.0.1 -p 5433 -U postgres allowance_test
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/allowance_test npm test
```

For browser checks, run the backend from `backend/` with `node --import tsx src/server.ts`, which doesn't load `.env`, and give it test values for `DATABASE_URL`, `PAYPAL_*`, `DEMO_MODE=on` and `MERCHANT_API_KEY`. The browser scripts and fake PayPal from this chat were temporary and may be gone.

## Where to read more

| File | What's in it |
|---|---|
| `README.md` | Overview, judge's guide, setup |
| `SUBMISSION.md` | Devpost text, 2:45 video script, final checklist |
| `DECISION.md` | Every decision and why; this chat's are D-062 to D-071 |
| `FLOW.md` | Build log; this chat is Phase 23 |
| `docs/LLD.md` | Detailed design: schema, pipeline, API table |
| `docs/openapi.yaml` | Agent and merchant API |

**Sources:** [PayPal hackathon post](https://developer.paypal.com/community/blog/PayPal_AI_Hackathon) · [Devpost page](https://paypalaihackathon.devpost.com/) · [Render monorepo docs](https://render.com/docs/monorepo-support)
