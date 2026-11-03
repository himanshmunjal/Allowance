import { Hono } from "hono";
import { z } from "zod";
import { requireMember, type AppEnv } from "../http";
import { runAgentTurn } from "../lib/agent";

const Body = z.object({
  conversationId: z.string().min(8).max(64),
  message: z.string().trim().min(1).max(2000),
});

export const chatRoutes = new Hono<AppEnv>()
  .use("*", requireMember)
  // POST /api/chat: one turn of the chat agent: the user's built-in agent, or for a child, shopping as that child (D-061).
  .post("/", async (c) => {
    const { conversationId, message } = Body.parse(await c.req.json());
    return c.json(await runAgentTurn(c.var.agent, conversationId, message));
  });
