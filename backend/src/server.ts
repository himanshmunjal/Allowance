import { serve } from "@hono/node-server";
import { app } from "./app";
import { config } from "./lib/config";
import { describeProviders } from "./lib/llm";
import { catalogSource } from "./lib/catalog";
import { ensureDatabase } from "./lib/db";

const port = Number(process.env.PORT ?? 4000);

// Connect + migrate before accepting requests, so a bad DATABASE_URL fails loudly at startup.
try {
  await ensureDatabase();
} catch (err) {
  console.error(`\n❌ Can't use the PostgreSQL database: ${(err as Error).message}`);
  console.error("   Set DATABASE_URL in backend/.env, e.g. postgres://postgres:<password>@localhost:5432/allowance\n");
  process.exit(1);
}

serve({ fetch: app.fetch, port }, (info) => {
  const ai = describeProviders();
  console.log(`Allowance API listening on http://localhost:${info.port}`);
  console.log(`  frontend (APP_URL): ${config.appUrl()}`);
  console.log(`  AI providers: ${ai.length ? ai.map((p) => `${p.label} (${p.model})`).join(" → ") : "none configured, set a key in backend/.env"}`);
  console.log("  database: PostgreSQL");
  console.log(`  remote MCP: ${config.publicApiUrl()}/mcp  (Bearer <agent key>)`);
  console.log(`  catalog: ${catalogSource() === "channel3" ? "Channel3 live (demo catalog as fallback)" : "demo"}`);
});
