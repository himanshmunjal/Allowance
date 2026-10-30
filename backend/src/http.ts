import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config, ConfigError } from "./lib/config";
import { LlmError } from "./lib/llm";
import { PayPalError } from "./lib/paypal";
import { PurchaseInputError } from "./lib/purchase";
import { AuthError, userForSession } from "./lib/auth";
import { agentForKey, ensureBuiltinAgent, type AgentContext } from "./lib/agents";
import type { User } from "./shared/types";

/** Hono context variables set by the auth middlewares below. */
export type AppEnv = { Variables: { user: User; agent: AgentContext } };

export const SESSION_COOKIE = "allowance_session";

// Shared error → HTTP mapping so every route answers the same way (used by app.onError).

export function errorResponse(err: unknown): Response {
  if (err instanceof SyntaxError) {
    return Response.json({ error: "Request body is not valid JSON" }, { status: 400 });
  }
  if (err instanceof z.ZodError) {
    return Response.json({ error: "Invalid request", details: err.issues }, { status: 400 });
  }
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof PurchaseInputError) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  // PostgreSQL unreachable / wrong password / missing database (D-055).
  const code = (err as { code?: string })?.code;
  if (code === "ECONNREFUSED" || code === "28P01" || code === "3D000" || code === "28000") {
    console.error("[db]", (err as Error).message);
    return Response.json({ error: `Database unavailable (${code}). Check DATABASE_URL in backend/.env.` }, { status: 503 });
  }
  if (err instanceof ConfigError) {
    return Response.json({ error: err.message }, { status: 500 });
  }
  if (err instanceof PayPalError) {
    return Response.json(
      { error: `PayPal: ${err.message}`, paypalDebugId: err.debugId },
      { status: err.status >= 500 ? 502 : 400 },
    );
  }
  if (err instanceof LlmError) {
    // Every configured provider failed; this is the first provider's error.
    const message =
      err.kind === "rate_limit" ? "Free AI quota reached on every configured provider. Wait a minute and try again (or add a second provider key in backend/.env)."
      : err.kind === "auth" ? err.message
      : `AI unavailable right now: ${err.message}`;
    return Response.json({ error: message }, { status: err.kind === "rate_limit" ? 429 : err.kind === "auth" ? 500 : 502 });
  }
  console.error("[api] unexpected error", err);
  return Response.json({ error: "Something went wrong" }, { status: 500 });
}

/** Logged-in user from the session cookie (D-053). Sets c.var.user, and c.var.agent = their built-in chat agent. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await userForSession(getCookie(c, SESSION_COOKIE));
  if (!user) return c.json({ error: "Please log in." }, 401);
  c.set("user", user);
  c.set("agent", await ensureBuiltinAgent(user.id));
  await next();
};

/**
 * External agent from its own API key (D-054): "Authorization: Bearer alw_...". Sets c.var.agent
 * and c.var.user. Paused agents still authenticate (so they get a clear "paused" reason back),
 * revoked keys don't.
 */
export const requireAgentKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const agent = await agentForKey(key);
  if (!agent) return c.json({ error: "Unauthorized: send Authorization: Bearer <agent API key from your Allowance dashboard>" }, 401);
  c.set("agent", agent);
  c.set("user", { id: agent.userId, email: "" });
  await next();
};

/** Bearer-key check for the merchant (external store) API (D-051). */
export const requireMerchantKey: MiddlewareHandler = async (c, next) => {
  const expected = Buffer.from(config.merchantApiKey());
  const given = Buffer.from((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return c.json({ error: "Unauthorized: send Authorization: Bearer <MERCHANT_API_KEY>" }, 401);
  }
  await next();
};

/** Request log that skips the dashboard's 3-second ledger polling. */
export const requestLog: MiddlewareHandler = async (c, next) => {
  const started = Date.now();
  await next();
  const quiet = c.req.method === "GET" && c.res.status < 400;
  if (!quiet) console.log(`${c.req.method} ${c.req.path} → ${c.res.status} (${Date.now() - started} ms)`);
};
