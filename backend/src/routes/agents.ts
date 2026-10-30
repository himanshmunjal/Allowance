import { Hono } from "hono";
import { z } from "zod";
import { requireUser, type AppEnv } from "../http";
import { config } from "../lib/config";
import { AgentLimits, createAgent, listAgents, publicAgent, revokeAgent, updateAgent } from "../lib/agents";

// Dashboard API for managing your agents and their allowances (D-054). Logged-in users only.

const Patch = AgentLimits.partial().extend({ status: z.enum(["active", "paused"]).optional() });

export const agentAdminRoutes = new Hono<AppEnv>()
  .use("*", requireUser)
  .get("/", async (c) => c.json({ agents: (await listAgents(c.var.user.id)).map(publicAgent) }))
  // Where external agents connect (D-057): remote MCP URL and the REST base.
  .get("/connect", (c) => c.json({ mcpUrl: `${config.publicApiUrl()}/mcp`, apiUrl: `${config.publicApiUrl()}/api/agent` }))
  // The API key is in this response only; it can't be shown again.
  .post("/", async (c) => {
    const { agent, apiKey } = await createAgent(c.var.user.id, AgentLimits.parse(await c.req.json()));
    return c.json({ agent: publicAgent(agent), apiKey }, 201);
  })
  .patch("/:id", async (c) => {
    const agent = await updateAgent(c.var.user.id, c.req.param("id"), Patch.parse(await c.req.json()));
    return agent ? c.json({ agent: publicAgent(agent) }) : c.json({ error: "Agent not found" }, 404);
  })
  .delete("/:id", async (c) =>
    (await revokeAgent(c.var.user.id, c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "Agent not found" }, 404),
  );
