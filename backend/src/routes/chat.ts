import { Hono } from "hono";
import { z } from "zod";
import { requireUser, type AppEnv } from "../http";
import { runAgentTurn } from "../lib/agent";

const Body = z.object({
  conversationId: z.string().min(8).max(64),
  message: z.string().trim().min(1).max(2000),
});

export const chatRoutes = new Hono<AppEnv>()
  .use("*", requireUser)
  // POST /api/chat: run one turn of the user's built-in chat agent.
  .post("/", async (c) => {
    const { conversationId, message } = Body.parse(await c.req.json());
    return c.json(await runAgentTurn(c.var.agent, conversationId, message));
  });
