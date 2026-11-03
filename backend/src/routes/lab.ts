import { Hono } from "hono";
import { requireUser, type AppEnv } from "../http";
import { attackCount, runRedTeam } from "../lib/redteam";

// The Attack Lab (D-065). Each run uses throwaway accounts and never calls PayPal, so it can't touch
// this user's ledger, budget or money. Limited, because one attack spends one real AI call.

const COOLDOWN_MS = 20_000;
const lastRun = new Map<string, number>();

export const labRoutes = new Hono<AppEnv>()
  .use("*", requireUser)
  .get("/", (c) => c.json({ total: attackCount }))
  .post("/run", async (c) => {
    const now = Date.now();
    const previous = lastRun.get(c.var.user.id) ?? 0;
    if (now - previous < COOLDOWN_MS) {
      return c.json({ error: `One run at a time: try again in ${Math.ceil((COOLDOWN_MS - (now - previous)) / 1000)} seconds.` }, 429);
    }
    lastRun.set(c.var.user.id, now);
    for (const [id, at] of lastRun) if (now - at > COOLDOWN_MS) lastRun.delete(id);
    return c.json(await runRedTeam());
  });
