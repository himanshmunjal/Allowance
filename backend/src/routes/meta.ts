import { Hono } from "hono";
import { catalogSource, merchants, products, toView } from "../lib/catalog";
import { config } from "../lib/config";
import { describeProviders } from "../lib/llm";

export const metaRoutes = new Hono()
  // GET /api/catalog: the demo merchants and products, and which source search uses.
  .get("/catalog", (c) => c.json({ source: catalogSource(), merchants, products: products.map((p) => toView(p)) }))
  // GET /api/ai: configured AI providers in fallback order (shown in the chat header).
  .get("/ai", (c) => c.json({ providers: describeProviders(), riskCheck: config.riskCheck() }));
