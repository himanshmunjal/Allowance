import { Hono } from "hono";
import { agentOps } from "../mcp/ops";
import { requireAgentKey, type AppEnv } from "../http";

// REST API for external agents (used by the local stdio MCP server, D-010). Each agent sends its
// OWN key (D-054) and acts for that key's user, within that user's rules and the agent's allowance,
// through the exact same purchase pipeline as the chat agent. Same operations as /mcp (D-057).

export const agentRoutes = new Hono<AppEnv>()
  .use("*", requireAgentKey)
  .post("/search", async (c) => c.json(await agentOps(c.var.agent).search(await c.req.json())))
  .get("/status", async (c) => c.json(await agentOps(c.var.agent).status()))
  .post("/purchase", async (c) => c.json(await agentOps(c.var.agent).purchase(await c.req.json())))
  // Withdraw this agent's own request that is still waiting for approval.
  .post("/purchases/:id/withdraw", async (c) => c.json(await agentOps(c.var.agent).withdraw(c.req.param("id"))))
  .get("/transactions", async (c) => c.json(await agentOps(c.var.agent).transactions()));
