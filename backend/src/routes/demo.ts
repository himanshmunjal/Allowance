import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { requireUser, SESSION_COOKIE, type AppEnv } from "../http";
import { createSession } from "../lib/auth";
import { config } from "../lib/config";
import { query, queryOne } from "../lib/db";
import { checkDemoRate, cleanupDemoAccounts, createDemoAccount, DEMO_KID_PASSWORD, demoAvailable } from "../lib/demo";
import { getVaultId } from "../lib/wallet";

// One-click demo (D-067): no sign-up, no PayPal login.

export const demoRoutes = new Hono<AppEnv>()
  .get("/", (c) => c.json({ available: demoAvailable(), autoPay: Boolean(config.demo.vaultId()) }))
  .post("/start", async (c) => {
    if (!demoAvailable()) return c.json({ error: "The demo is switched off on this server. Create an account instead." }, 403);
    if (!checkDemoRate(c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "local")) {
      return c.json({ error: "Too many demo accounts from your network. Try again in an hour." }, 429);
    }
    await cleanupDemoAccounts();
    const account = await createDemoAccount();
    const { token, maxAge } = await createSession(account.user.id);
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: config.secureCookies(), path: "/", maxAge });
    return c.json(account, 201);
  })
  // What the demo banner shows: how to try the kid view, and whether auto-pay is live.
  .get("/info", requireUser, async (c) => {
    const row = await queryOne<{ is_demo: boolean }>("SELECT is_demo FROM users WHERE id = $1", [c.var.user.id]);
    if (!row?.is_demo) return c.json({ demo: false });
    const kids = await query<{ login_name: string }>("SELECT login_name FROM agents WHERE user_id = $1 AND kind = 'child' AND login_name IS NOT NULL ORDER BY created_at LIMIT 1", [c.var.user.id]);
    return c.json({ demo: true, kidLogin: kids[0]?.login_name ?? null, kidPassword: DEMO_KID_PASSWORD, autoPay: Boolean(await getVaultId(c.var.user.id)) });
  });
