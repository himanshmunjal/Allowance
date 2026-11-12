---
intro: Allowance is a trust layer that lets an AI shopping agent pay with PayPal within rules you write in plain English. Every purchase goes through a deterministic policy engine and an AI risk check, then is auto-paid from a saved PayPal wallet, sent to you for one-tap approval, or blocked with a reason.
caption: A Shopping agent or an external MCP agent sends a purchase request to the Hono API, the Purchase pipeline prices it from the Catalog, runs the Injection screen, Policy engine and AI risk check, records it in PostgreSQL under a per-user lock, and then pays through PayPal or sends it to the Approval page.
---

## About

AI agents can already find products. What stops people letting them pay is trust: an agent can overspend, charge twice on a retry, or follow instructions hidden in a listing. Allowance gives it the controls you'd give a teenager with a card: a weekly budget, an auto-pay limit, caps, blocked categories and trusted sellers.

The core rule is that **the AI proposes and the code decides: can an agent be allowed to pay real money while no model output, injected text or retry is able to break a limit?**

## Architecture

Requests come from the **Shopping agent** (a tool-calling loop on Gemini, Groq or Claude) or from an **MCP agent** through the MCP server. Both call `request_purchase` on the **Hono API**. The **Purchase pipeline** fetches the price from the **Catalog** (Channel3 or a demo catalog), so the agent cannot name a price. It then runs the **Injection screen** and the **Policy engine**, the retry and split guards, and the **AI risk check**, which can only make a decision stricter.

The final checks and the ledger insert happen in one transaction in **PostgreSQL**, under a per-user advisory lock. An allowed purchase is paid through **PayPal** with Orders v2 and the saved Vault token. One that needs a human goes to the **Approval page** in the Next.js frontend, where the PayPal button captures it. **PayPal webhooks** come back to the API to reconcile captures, turn off auto-pay when consent is withdrawn and pause an agent on a dispute.

## How it's implemented

### Price and limits live in code

`request_purchase` takes a product id, a quantity and a reason, nothing else. The price is re-read at purchase time, and English rules are parsed into a typed policy the model can never loosen.

### Defences in layers

A deterministic injection screen catches instructions in listings, product names and store names, including Unicode disguises. It is a pattern filter, so I don't treat it as a guarantee. The worst an injected agent can do is still bounded by the budget, caps and categories. The AI risk check asks whether the cart matches what the user asked for, and it fails safe to "needs approval" if every provider is down.

### No races, no double charges

Twelve purchases racing a $50 budget are serialised by `pg_advisory_xact_lock` on the user, so the budget re-check and the insert are atomic. Each payment carries a `PayPal-Request-Id`. If PayPal's answer is lost, the purchase stays `PROCESSING` and keeps holding budget, and it is settled by re-sending the same id instead of being reported as failed when it may have been charged.

### An Attack Lab you can run

`npm run redteam` and the in-app Attack Lab fire 18 scripted attacks at the real pipeline with PayPal stubbed out. On every attack the code is meant to stop, the AI reviewer is rigged to approve everything, so the code has to hold on its own.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (Node 22) | One type set shared by backend and frontend |
| Framework | Hono API, Next.js 16, MCP SDK | Small API, an approval UI, and access for any MCP agent |
| AI | Gemini, Groq, Claude with fallback | Free tiers are enough; one outage doesn't stop the app |
| Payments | PayPal Vault v3, Orders v2, Payments v2, JS SDK v6, webhooks | Auto-pay, approval, refunds and reconciliation |
| Storage | PostgreSQL | Advisory locks and transactions make the budget check atomic |
| Infra and testing | Docker Compose, Render blueprint, GitHub Actions, 82 tests with a fake PayPal, newman | Tests need no keys and run in CI |

## Results

| Measure | Baseline | Best |
|---|---|---|
| Attack Lab scenarios stopped (`npm run redteam`) | n/a | **18 of 18** |
| Budget race: 12 purchases against a $50 budget | $50 cap | **$40 committed**, 10 of 12 refused |
| Backend test cases with a fake PayPal (unit, API, red-team) | n/a | **82** |
| Postman collection run by newman | n/a | **9 requests, 19 assertions** green |
| APIMatic audit of the OpenAPI spec | n/a | **99 / 100** |

These are correctness checks, not accuracy numbers. The red-team suite is written by me, so it shows that known attacks are stopped, not that unknown ones are. I ran `npm run redteam` for the red-team rows; the other figures come from the test files and README.

## What I'd do differently

- Host the live demo. The README still has a placeholder URL, and a judge can't try what isn't deployed.
- Replace the pattern-based injection screen with a classifier evaluated on a held-out set of injections, and report its miss rate.
- Measure the AI risk check on a labelled set of matching and mismatched carts, so its value is a number and not a claim.
