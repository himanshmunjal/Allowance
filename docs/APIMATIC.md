# How the APIMatic Context Plugin was used

APIMatic's Context Plugin (ContextMatic) is an MCP server that gives a coding agent the PayPal Server SDK's documentation: `fetch_api`, `ask`, `endpoint_search`, `model_search`. It was installed in Claude Code (`/plugin install context-matic@apimatic-context-matic`, connected as `plugin:context-matic:context-matic`) and used to check the PayPal calls Allowance already makes, with the API key `paypal` and language `typescript`. Allowance calls PayPal's REST API directly (D-018), and the SDK documents the same endpoints, so the answers apply.

Date: 2026-11-04. Every row below is a question that was actually asked.

| # | Question | What the plugin said | What changed |
|---|---|---|---|
| 1 | What does PayPal return when a vaulted payment token is deleted, revoked or invalid? | It could not say. `CreateOrder` documents only 400, 401 and 422 ("failed business validation"), with no issue codes for tokens or declines | **Changed (D-074).** The guessed issue codes could not be confirmed, so at the order-creation step any 422 now sends the purchase to the owner for approval. At capture it does not, because a 422 there can mean "already captured" |
| 2 | What body charges a saved wallet for a merchant-initiated payment? | `paymentSource.paypal.vaultId`, optionally with `storedCredential` (`paymentInitiator: MERCHANT`, `usage: SUBSEQUENT`). Not stated as mandatory. Creating the order does not guarantee `COMPLETED`: capture it | Confirmed our flow already captures when the order isn't `COMPLETED`. `storedCredential` was **not** added: auto-pay works live without it, and it can't be re-tested without sandbox keys |
| 3 | How long does PayPal remember a `PayPal-Request-Id`? | 6 hours on order calls (more by arrangement), mandatory for single-step orders with a `vault_id`. 45 days for refunds | Confirmed our 3-hour recovery cut-off is inside the window, and that our create, capture and refund calls all send the header. A code comment now states the real figure |
| 4 | How is a refund requested, and which statuses exist? | `RefundRequest` takes `amount`, `customId`, `invoiceId`, `noteToPayer`. A refund's status is `COMPLETED`, `PENDING`, `FAILED` or `CANCELLED` | **Bug fixed.** A refund PayPal reported as `FAILED` or `CANCELLED` used to mark the purchase `REFUNDED`. It now stays `PAID`, an audit entry is written, and the owner is told. Refunds also send our transaction id as `custom_id` |
| 5 | Which capture statuses exist? | `COMPLETED`, `DECLINED`, `PARTIALLY_REFUNDED`, `PENDING`, `REFUNDED`, `FAILED` | No change: the Verify with PayPal check already accepts exactly these |
| 6 | How is a webhook signature verified, and which events exist? | No answer: the plugin's SDK covers Orders, Payments, Vault, Transaction Search and Subscriptions, not webhooks | None. Our webhook verification is **not** checked by the plugin |

## What this did not settle

* The real error code for a revoked token (row 1). Allowance now doesn't depend on knowing it, but it is still unconfirmed.
* Whether adding `storedCredential` would help (row 2). Worth a try in the PayPal sandbox.
* Webhook handling (row 6).

## Tests

`npm test` (84 tests, no keys needed) covers rows 1 and 4: an unknown 422 at order creation asks the owner; a 422 at capture never becomes a second payment (removing that condition makes the test fail); a failed or cancelled refund leaves the purchase paid; a refund carries `custom_id` and a retry-safe request id.

## Text for the Devpost form: "Description of Context Plugin usage"

> Installed APIMatic's Context Plugin (ContextMatic) in Claude Code and used its `fetch_api`, `ask`, `endpoint_search` and `model_search` tools against the PayPal Server SDK docs to check the PayPal calls Allowance makes. It confirmed our request-id window and capture statuses, and found a real bug: a refund PayPal reported as FAILED or CANCELLED was still marked refunded. Fixed, with tests. It could not confirm PayPal's error codes for a revoked saved wallet, so we made that path safe without depending on them. Every question, answer and change is logged in docs/APIMATIC.md in the repo. We also ran our OpenAPI spec through APIMatic's audit (68, then 54, then 99/100 after rebuilding it from the audit's own rules) and have a portal project in src/.
