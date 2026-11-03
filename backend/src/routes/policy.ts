import { Hono } from "hono";
import { z } from "zod";
import { requireUser, type AppEnv } from "../http";
import { applySuggestion, suggestions } from "../lib/advisor";
import { describePolicy, getPolicy, PolicySchema, savePolicy, spendSummary } from "../lib/policy";
import { parseRules } from "../lib/rules-parser";

const ParseBody = z.object({ text: z.string().trim().min(3).max(1500), apply: z.boolean().default(true) });

export const policyRoutes = new Hono<AppEnv>()
  .use("*", requireUser)
  .get("/", async (c) => {
    const { policy, sourceText } = await getPolicy(c.var.user.id);
    return c.json({ policy, sourceText, summary: describePolicy(policy), spend: await spendSummary(c.var.user.id, policy) });
  })
  .put("/", async (c) => {
    const body = z.object({ policy: PolicySchema }).parse(await c.req.json());
    const policy = await savePolicy(c.var.user.id, body.policy);
    return c.json({ policy, summary: describePolicy(policy) });
  })
  // Rule advisor (D-068): suggestions from the user's own decisions. Applying is always an explicit click.
  .get("/suggestions", async (c) => c.json(await suggestions(c.var.user.id)))
  .post("/suggestions/:id/apply", async (c) => {
    const applied = await applySuggestion(c.var.user.id, c.req.param("id"));
    return applied ? c.json(applied) : c.json({ error: "That suggestion no longer applies." }, 409);
  })
  // POST /api/policy/parse: plain English → structured policy (AI).
  .post("/parse", async (c) => {
    const { text, apply } = ParseBody.parse(await c.req.json());
    const parsed = await parseRules(text, (await getPolicy(c.var.user.id)).policy);
    const policy = apply ? await savePolicy(c.var.user.id, parsed.policy, text) : parsed.policy;
    return c.json({ policy, summary: parsed.summary, rules: describePolicy(policy), applied: apply });
  });
