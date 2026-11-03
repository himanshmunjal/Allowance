import { createHash, randomBytes } from "node:crypto";
import { config } from "./config";
import { audit, newId, query, queryOne, withTransaction } from "./db";
import { childForLogin, createAgentWithKey, ensureBuiltinAgent, type AgentContext } from "./agents";
import { hashPassword, verifyPassword } from "./passwords";
import type { User } from "../shared/types";

// Accounts and sessions (DECISION.md D-053). Passwords: scrypt with a per-user salt. Sessions:
// a random token in an HttpOnly cookie; only its SHA-256 is stored, so a database leak doesn't
// leak usable sessions.

const SESSION_DAYS = 30;

export class AuthError extends Error {
  constructor(message: string, public status: 400 | 401 | 409 | 429 = 400) {
    super(message);
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const normalizeEmail = (email: string) => email.trim().toLowerCase();

type UserRow = { id: string; email: string; password_hash: string };

export async function signUp(email: string, password: string): Promise<User> {
  const clean = normalizeEmail(email);
  const passwordHash = await hashPassword(password);
  const user = await withTransaction(async (client) => {
    const existing = await queryOne("SELECT 1 FROM users WHERE email = $1", [clean], client);
    if (existing) throw new AuthError("An account with this email already exists. Log in instead.", 409);
    const first = !(await queryOne("SELECT 1 FROM users WHERE NOT is_demo LIMIT 1", [], client));
    const row = await queryOne<UserRow>(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email, password_hash",
      [newId("usr"), clean, passwordHash],
      client,
    );
    return { id: row!.id, email: row!.email, first };
  });
  await ensureBuiltinAgent(user.id);
  // Keep the MCP server and scripts working: the .env key becomes the first account's first agent.
  const legacyKey = config.legacyAgentKey();
  if (user.first && legacyKey) await createAgentWithKey(user.id, { name: "MCP agent (key from .env)" }, legacyKey).catch(() => {});
  await audit(user.id, "ACCOUNT_CREATED", `Account created for ${user.email}`);
  return { id: user.id, email: user.email };
}

/** A child logs in with the username their parent picked (no "@"), and acts inside the parent's account (D-061). */
export async function logInChild(loginName: string, password: string): Promise<{ user: User; child: AgentContext }> {
  const child = await childForLogin(loginName, password);
  if (!child) throw new AuthError("Wrong username or password.", 401);
  return { user: { id: child.userId, email: "" }, child };
}

export async function logIn(email: string, password: string): Promise<User> {
  const row = await queryOne<UserRow>("SELECT id, email, password_hash FROM users WHERE email = $1", [normalizeEmail(email)]);
  // Same error either way: don't reveal which emails have accounts.
  if (!row || !(await verifyPassword(password, row.password_hash))) throw new AuthError("Wrong email or password.", 401);
  return { id: row.id, email: row.email };
}

/** childId set = a child's session (D-061): it acts as that child, inside the parent's account. */
export async function createSession(userId: string, childId: string | null = null): Promise<{ token: string; maxAge: number }> {
  const token = randomBytes(32).toString("base64url");
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  await query("INSERT INTO sessions (token_hash, user_id, agent_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))", [
    sha256(token),
    userId,
    childId,
    maxAge,
  ]);
  return { token, maxAge };
}

export type Session = { user: User; childId: string | null };

export async function sessionFor(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  const row = await queryOne<{ id: string; email: string; agent_id: string | null }>(
    "SELECT u.id, u.email, s.agent_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()",
    [sha256(token)],
  );
  return row ? { user: { id: row.id, email: row.email }, childId: row.agent_id } : null;
}

export async function deleteSession(token: string | undefined) {
  if (token) await query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
}

// ---------- simple in-memory brute-force limit for login/sign-up ----------

const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

/** Throws once a key (ip + email) has failed too often in the last 15 minutes. */
export function checkRateLimit(key: string) {
  const entry = attempts.get(key);
  if (entry && entry.resetAt > Date.now() && entry.count >= MAX_ATTEMPTS) {
    throw new AuthError("Too many attempts. Wait a few minutes and try again.", 429);
  }
}

export function recordFailure(key: string) {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < Date.now()) attempts.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else entry.count++;
}

export const clearFailures = (key: string) => attempts.delete(key);
