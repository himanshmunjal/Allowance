import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config";
import { audit, newId, query, queryOne, withTransaction } from "./db";
import { createAgentWithKey, ensureBuiltinAgent } from "./agents";
import type { User } from "../shared/types";

// Accounts and sessions (DECISION.md D-053). Passwords: scrypt with a per-user salt. Sessions:
// a random token in an HttpOnly cookie; only its SHA-256 is stored, so a database leak doesn't
// leak usable sessions.

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const SESSION_DAYS = 30;

export class AuthError extends Error {
  constructor(message: string, public status: 400 | 401 | 409 | 429 = 400) {
    super(message);
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const normalizeEmail = (email: string) => email.trim().toLowerCase();

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { ...SCRYPT, N: Number(n) });
  return timingSafeEqual(actual, expected);
}

type UserRow = { id: string; email: string; password_hash: string };

export async function signUp(email: string, password: string): Promise<User> {
  const clean = normalizeEmail(email);
  const passwordHash = await hashPassword(password);
  const user = await withTransaction(async (client) => {
    const existing = await queryOne("SELECT 1 FROM users WHERE email = $1", [clean], client);
    if (existing) throw new AuthError("An account with this email already exists. Log in instead.", 409);
    const first = !(await queryOne("SELECT 1 FROM users LIMIT 1", [], client));
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

export async function logIn(email: string, password: string): Promise<User> {
  const row = await queryOne<UserRow>("SELECT id, email, password_hash FROM users WHERE email = $1", [normalizeEmail(email)]);
  // Same error either way: don't reveal which emails have accounts.
  if (!row || !(await verifyPassword(password, row.password_hash))) throw new AuthError("Wrong email or password.", 401);
  return { id: row.id, email: row.email };
}

export async function createSession(userId: string): Promise<{ token: string; maxAge: number }> {
  const token = randomBytes(32).toString("base64url");
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  await query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))", [
    sha256(token),
    userId,
    maxAge,
  ]);
  return { token, maxAge };
}

export async function userForSession(token: string | undefined): Promise<User | null> {
  if (!token) return null;
  return queryOne<User>(
    "SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()",
    [sha256(token)],
  );
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
