import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { requireMember, SESSION_COOKIE, type AppEnv } from "../http";
import { publicAgent } from "../lib/agents";
import { checkRateLimit, clearFailures, createSession, deleteSession, logIn, logInChild, recordFailure, signUp, AuthError } from "../lib/auth";
import { config } from "../lib/config";

// Email + password accounts (D-053). The browser talks to this API through the frontend's /api
// proxy, so the session cookie lives on the frontend's origin; HttpOnly + SameSite=Lax.

const Credentials = z.object({
  email: z.email().max(200),
  password: z.string().min(8, "Use at least 8 characters").max(200),
});

async function startSession(c: Parameters<typeof setCookie>[0], userId: string, childId: string | null = null) {
  const { token, maxAge } = await createSession(userId, childId);
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: config.secureCookies(), path: "/", maxAge });
}

export const authRoutes = new Hono<AppEnv>()
  .post("/signup", async (c) => {
    const { email, password } = Credentials.parse(await c.req.json());
    const user = await signUp(email, password);
    await startSession(c, user.id);
    return c.json({ user }, 201);
  })
  .post("/login", async (c) => {
    const { email, password } = z.object({ email: z.string().max(200), password: z.string().max(200) }).parse(await c.req.json());
    const key = `${c.req.header("x-forwarded-for") ?? "local"}|${email.toLowerCase()}`;
    checkRateLimit(key);
    try {
      // "email" is an email (parent) or a child's username (no "@", D-061).
      if (!email.includes("@")) {
        const { user, child } = await logInChild(email, password);
        clearFailures(key);
        await startSession(c, user.id, child.id);
        return c.json({ user, role: "child" });
      }
      const user = await logIn(email, password);
      clearFailures(key);
      await startSession(c, user.id);
      return c.json({ user, role: "owner" });
    } catch (err) {
      if (err instanceof AuthError) recordFailure(key);
      throw err;
    }
  })
  .post("/logout", async (c) => {
    await deleteSession(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  })
  // Me (D-061): a child gets their own profile; a parent's email is never shown to the child.
  .get("/me", requireMember, (c) =>
    c.json(
      c.var.role === "child"
        ? { user: { id: c.var.user.id, email: "" }, role: "child", child: publicAgent(c.var.agent) }
        : { user: c.var.user, role: "owner", child: null },
    ),
  );
