# Devpost submission kit

Paste-ready text for the submission form, and a script for the demo video. Remove or replace anything marked TODO first.

## Tagline

Give your AI agent an allowance, not your wallet.

## What it does

AI agents can already find what you want. What stops people letting them pay is trust: what if it overspends, buys the wrong thing, pays twice, or gets talked into something by a shady listing?

Allowance is a trust layer between any AI agent and your PayPal. You write rules in plain English. Agents get their own keys and their own allowances, and they can only ask. Every purchase goes through one pipeline, and ends one of three ways: paid automatically from your saved PayPal, sent to you for one-tap approval in PayPal, or blocked with a reason.

**The AI proposes, the code decides.** A model can't raise a limit, can't name a price, and can't approve its own purchase. The AI risk check can only make a decision stricter.

- **Attack Lab.** 18 attacks fired live at the real pipeline: prompt injection, double charges, purchase splitting, budget races. On 17 of them, the AI reviewer is rigged to approve everything, so the code has to hold alone.
- **Any agent, over MCP.** Point any MCP client at a URL with its own key: same rules, same ledger.
- **Pay with Allowance.** A demo store shows how a merchant integrates: the store sets the price, Allowance decides.
- **Parental controls.** A child is an allowance holder with their own login. Anything over their limit goes to the parent, and age-restricted goods are always blocked.
- **Spending Explorer.** The full ledger on AG Grid. Ask it a question in English, and check every row against PayPal's own record.
- **Rule advisor.** Your approvals and rejections become suggested rules, and nothing changes until you click Apply.

## How we built it

Next.js and a Hono API in TypeScript, with PostgreSQL. A per-user database lock serializes each purchase decision, so racing requests can't overspend.

**PayPal:** Orders v2 (create, capture, and merchant-initiated payments with a vaulted wallet), Vault v3 (save with purchase, and without), JS SDK v6 (the approval button), Payments v2 (refunds, and reading captures back for reconciliation), and signature-verified webhooks. A dispute pauses the agent responsible, and removing consent in PayPal turns auto-pay off at once. Every write carries a `PayPal-Request-Id`, so a lost response can be retried without charging twice.

**Testing:** `npm test` needs no keys. It runs every attack, plus a fake PayPal that drops the connection after charging, to prove there is exactly one charge.

## Tools used

| Tool | How it's used |
|---|---|
| Google Gemini (default), Groq, Anthropic Claude | Any one is enough, with automatic fallback. Shopping agent with tool use, risk review, plain-English rules to a typed policy, English questions to a grid view, and explaining rule suggestions |
| Model Context Protocol | Remote (HTTP) and local (stdio) server, so any agent can shop through Allowance |
| AG Grid | The Spending Explorer: filters, sorting, pagination and CSV, driven by an AI question box, with a live PayPal column |
| Channel3 | Live product search across real retailers, with prices re-checked at purchase |
| Render | Blueprint deploy of two services and PostgreSQL |
| Postman / APIMatic | `docs/openapi.yaml` can be imported into either to explore the API or generate SDKs |
| Claude Code | AI coding assistant used during development |

## What's next

Approval alerts by Zapier or push, multiparty onboarding so real stores get paid directly, and signed receipts a store can verify.

## Links

- Hosted demo: TODO_HOSTED_URL
- Code: https://github.com/himanshmunjal/Allowance
- Video: TODO_YOUTUBE_URL
- Sandbox buyer for the PayPal button: TODO_SANDBOX_BUYER_EMAIL / TODO_SANDBOX_BUYER_PASSWORD

---

## Demo video script (2:45)

Judges aren't required to watch past 3:00, so keep the strongest material early. Record on the hosted build. Use no third-party music, and avoid showing other companies' trademarks or real retailer branding: use the demo catalog (`CATALOG_SOURCE=demo`) for the recording. Have the AI quota fresh, and rehearse once to warm up the free tier.

| Time | On screen | Say |
|---|---|---|
| 0:00 | Landing page | "AI agents can find what you want. Would you let one pay? What if it spends too much, pays twice, or a listing tells it to buy ten? This is Allowance: give your agent an allowance, not your wallet." |
| 0:15 | Click Try the live demo, then the rules panel | "One click, sandbox money. I write rules in plain English, and they become a policy enforced in code. The AI proposes. The code decides." |
| 0:30 | Chat: "Buy me a bag of coffee beans, something fruity." Show PAID, then the ledger row expanded | "It compares, picks, and pays with my saved PayPal, no popup, because it passed every check. Here's each one." |
| 0:55 | Chat: earbuds, then the approval page, then the PayPal button, then paid | "Seventy-nine dollars is over my limit, so it asks. I see its reasoning and approve in PayPal." |
| 1:20 | Refund a purchase, briefly | "And I can undo it, with a real PayPal refund." |
| 1:30 | Attack Lab: click Run, let the results land, open "Splitting to dodge the limit" | "Now let's try to break it. These are real attacks on the real pipeline. On almost all of them I've rigged the AI to approve everything, so only the code can stop them. Prompt injection, double charges, budget races. Eighteen for eighteen." |
| 2:00 | Terminal or Agents tab: an external MCP agent's purchase landing in the ledger | "It works for any agent. An outside agent connects over MCP with its own key and its own allowance, and hits the same rules." |
| 2:15 | Explorer: "Biggest purchases you blocked", then Verify with PayPal | "On AG Grid, I can ask my ledger a question, and check every payment against PayPal's own records." |
| 2:30 | Log in as the child, ask for a beer, blocked | "The same idea works for a kid's allowance." |
| 2:40 | Landing page | "Allowance. Let agents pay, without handing over the wallet." |

## Before you submit

- [ ] Commit everything: parental controls and this work are not in git yet
- [ ] `npm run dev` with your real keys, and test: auto-pay, the PayPal button, refund, Verify with PayPal
- [ ] `npm run check-ai`, then `npm run redteam` to see the AI attack run on a real model
- [ ] Deploy on Render, set `APP_URL`, `BACKEND_URL` and `DEMO_VAULT_ID`, and test in a private window
- [ ] Add the PayPal webhook and try the Webhooks Simulator
- [ ] Replace every TODO in `README.md` and this file
- [ ] Confirm CI is green on GitHub
- [ ] Add a description, website and topics to the repo's About section
- [ ] Read the Devpost judging criteria and sponsor prize rules, then adjust this text
- [ ] Upload the video to YouTube as public, under 3 minutes
