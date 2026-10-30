import { Hono } from "hono";
import { cors } from "hono/cors";
import { errorResponse, requestLog } from "./http";
import { config } from "./lib/config";
import { agentRoutes } from "./routes/agent";
import { agentAdminRoutes } from "./routes/agents";
import { authRoutes } from "./routes/auth";
import { approvalRoutes } from "./routes/approvals";
import { chatRoutes } from "./routes/chat";
import { ledgerRoutes } from "./routes/ledger";
import { mcpRoutes } from "./mcp/http";
import { merchantRoutes } from "./routes/merchant";
import { metaRoutes } from "./routes/meta";
import { policyRoutes } from "./routes/policy";
import { walletRoutes } from "./routes/wallet";
import { webhookRoutes } from "./routes/webhook";

// The Allowance API. The frontend proxies /api/* here (frontend/next.config.ts), so browsers
// talk to one origin; CORS is only for calling the API directly from the frontend's origin.

export const app = new Hono();

app.use("*", requestLog);
app.use("/api/*", cors({ origin: () => config.appUrl() }));

app.get("/health", (c) => c.json({ ok: true, service: "allowance-backend" }));

app.route("/api", metaRoutes); // /api/catalog, /api/ai
app.route("/api/auth", authRoutes);
app.route("/api/agents", agentAdminRoutes); // manage your agents (session)
app.route("/api/chat", chatRoutes);
app.route("/api/policy", policyRoutes);
app.route("/api/transactions", ledgerRoutes);
app.route("/api/approvals", approvalRoutes);
app.route("/api/wallet", walletRoutes);
app.route("/api/paypal/webhook", webhookRoutes);
app.route("/api/agent", agentRoutes); // used BY agents (agent API key)
app.route("/api/merchant", merchantRoutes);
app.route("/mcp", mcpRoutes); // remote MCP for external agents (agent API key)

app.notFound((c) => c.json({ error: `No route for ${c.req.method} ${c.req.path}` }, 404));
app.onError((err) => errorResponse(err));
