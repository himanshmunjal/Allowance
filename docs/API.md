# Using the API: Postman, APIMatic and `curl`

Everything an outside agent or store can do is described in [`openapi.yaml`](openapi.yaml). It is checked with `npx @redocly/cli lint docs/openapi.yaml` (no errors).

There are two kinds of key:

| Key | Who holds it | How to get it |
|---|---|---|
| Agent key (`alw_…`) | An AI agent | Dashboard → Agents → create one. Shown once |
| `MERCHANT_API_KEY` | A store | Set in `backend/.env` |

## Postman

1. Import [`postman/allowance.postman_collection.json`](postman/allowance.postman_collection.json) and [`postman/allowance.postman_environment.json`](postman/allowance.postman_environment.json).
2. In the environment, set `baseUrl` (default `http://localhost:4000`), `agentKey` and `merchantKey`.
3. Run the **Agent** folder top to bottom. "Ask to buy something" saves the purchase's id, so "Cancel this agent's own request" can withdraw it.

From a terminal, with Postman's command-line runner:

```bash
npx newman run docs/postman/allowance.postman_collection.json \
  --env-var baseUrl=http://localhost:4000 \
  --env-var agentKey=alw_... --env-var merchantKey=...
```

Against a local backend this runs 9 requests and 19 assertions. The collection was generated from the spec, then given real example bodies, per-folder authentication and tests.

## APIMatic

`openapi.yaml` is written to import cleanly: every operation has an `operationId`, every field has a description and an example, response bodies are named schemas, the two key types are declared as security schemes, and the server URL is a variable. APIMatic scored version 1.3.0 at 99/100 (history below). The portal project APIMatic set up from it lives in [`src/`](../src): `src/spec/openapi.yaml` is a copy of this spec, `src/apimatic.json` is the portal config (C#, TypeScript and Python SDKs), and `src/content/` holds the pages and navigation, which includes a Context Plugin tab next to the SDKs and API reference.

**Keep the two copies of the spec in step.** `docs/openapi.yaml` is the one the Postman collection and the Redocly check use; after changing it, copy it over `src/spec/openapi.yaml`.

## curl

```bash
curl -s localhost:4000/api/agent/search -H "Authorization: Bearer $AGENT_KEY" \
  -H 'content-type: application/json' -d '{"query":"coffee beans","maxPrice":25}'
```

MCP clients don't need any of this: point them at `/mcp` with the same agent key.

## Spec score history (APIMatic)

| Version | Score | Issues |
|---|---|---|
| 1.1.0 (before) | 68 / 100 (SDK 99, docs 89, AI tools 83) | 183 |
| 1.2.0 (first rewrite) | 54 / 100 | not recorded |
| 1.3.0 (rebuilt from APIMatic's own rule list) | **99 / 100** | not recorded |
