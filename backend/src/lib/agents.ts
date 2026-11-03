import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { CATEGORIES } from "./categories";
import { audit, jsonb, newId, query, queryOne, type Queryable } from "./db";
import { hashPassword, verifyPassword } from "./passwords";
import type { Agent, AgentStatus, Category } from "../shared/types";

// Per-agent allowances (DECISION.md D-054). Every purchase belongs to one agent: the built-in
// chat agent, or an external agent that authenticates with its own API key. An agent's limits
// sit ON TOP of the user's rules: they can make a purchase stricter, never looser.

const KEY_PREFIX = "alw_";
const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export const AgentLimits = z.object({
  name: z.string().trim().min(2).max(60),
  weeklyBudget: z.number().min(0).max(100_000).nullable().default(null),
  autoPayLimit: z.number().min(0).max(100_000).nullable().default(null),
  allowedCategories: z.array(z.enum(CATEGORIES)).default([]),
  alwaysAsk: z.boolean().default(false),
});
export type AgentLimits = z.infer<typeof AgentLimits>;

/** A partial update: only the fields sent change. (AgentLimits.partial() would fill the defaults back in.) */
export const AgentPatch = z.object({
  name: AgentLimits.shape.name.optional(),
  weeklyBudget: z.number().min(0).max(100_000).nullable().optional(),
  autoPayLimit: z.number().min(0).max(100_000).nullable().optional(),
  allowedCategories: z.array(z.enum(CATEGORIES)).optional(),
  alwaysAsk: z.boolean().optional(),
});

// Parental controls (D-061): a child is an agent that is a person. The parent picks a username and
// password; the child logs in with them and shops (chat, Pay with Allowance) inside the parent's
// rules and their own allowance, which a child must always have.
export const LoginName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,30}$/, "Username: 3-30 letters, numbers, dots, dashes or underscores (no spaces or @)");
export const ChildPassword = z.string().min(6, "Child's password: at least 6 characters").max(200);
export const ChildInput = AgentLimits.extend({
  weeklyBudget: z.number().min(0).max(100_000),
  loginName: LoginName,
  password: ChildPassword,
});
export type ChildInput = z.infer<typeof ChildInput>;

/** A request a parent can fix (e.g. the username is taken). */
export class AgentInputError extends Error {
  constructor(message: string, public status: 400 | 409 = 400) {
    super(message);
  }
}

type AgentRow = {
  id: string;
  user_id: string;
  name: string;
  kind: Agent["kind"];
  key_hint: string | null;
  login_name: string | null;
  weekly_budget: number | null;
  auto_pay_limit: number | null;
  allowed_categories: Category[];
  always_ask: boolean;
  status: AgentStatus;
  created_at: string;
  last_used_at: string | null;
  spent_this_week?: number;
};

/** Agent plus the id of the user it acts for (internal; never sent to the browser as-is). */
export type AgentContext = Agent & { userId: string };

function toAgent(r: AgentRow): AgentContext {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    kind: r.kind,
    keyHint: r.key_hint,
    loginName: r.login_name,
    weeklyBudget: r.weekly_budget,
    autoPayLimit: r.auto_pay_limit,
    allowedCategories: r.allowed_categories,
    alwaysAsk: r.always_ask,
    status: r.status,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    spentThisWeek: r.spent_this_week ?? 0,
  };
}

// Rolling 7-day spend, same window and statuses as the user's budget (policy.ts).
const SPEND_SQL = `COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.agent_id = a.id
  AND t.created_at >= now() - interval '7 days' AND t.status IN ('PROCESSING', 'PAID', 'PENDING_APPROVAL')), 0)`;

// Never select password_hash / key_hash into an Agent: list the columns toAgent needs.
const COLS = "a.id, a.user_id, a.name, a.kind, a.key_hint, a.login_name, a.weekly_budget, a.auto_pay_limit, a.allowed_categories, a.always_ask, a.status, a.created_at, a.last_used_at";

export function publicAgent(a: AgentContext): Agent {
  const { userId: _userId, ...rest } = a;
  return rest;
}

export async function listAgents(userId: string): Promise<AgentContext[]> {
  const rows = await query<AgentRow>(
    `SELECT ${COLS}, ${SPEND_SQL} AS spent_this_week FROM agents a
     WHERE a.user_id = $1 AND a.status <> 'revoked' ORDER BY (a.kind = 'builtin') DESC, (a.kind = 'child') DESC, a.created_at`,
    [userId],
  );
  return rows.map(toAgent);
}

export async function getAgent(userId: string, agentId: string, on?: Queryable): Promise<AgentContext | null> {
  const row = await queryOne<AgentRow>(
    `SELECT ${COLS}, ${SPEND_SQL} AS spent_this_week FROM agents a WHERE a.id = $1 AND a.user_id = $2`,
    [agentId, userId],
    on,
  );
  return row ? toAgent(row) : null;
}

/** The built-in chat agent for a user; created on first use. It has no key and no extra limits by default. */
export async function ensureBuiltinAgent(userId: string): Promise<AgentContext> {
  const existing = await queryOne<{ id: string }>("SELECT id FROM agents WHERE user_id = $1 AND kind = 'builtin'", [userId]);
  if (existing) return (await getAgent(userId, existing.id))!;
  const id = newId("agt");
  await query("INSERT INTO agents (id, user_id, name, kind, status) VALUES ($1, $2, 'Chat agent (built-in)', 'builtin', 'active')", [id, userId]);
  return (await getAgent(userId, id))!;
}

/** Creates an external agent. The API key is returned ONCE; only its hash is stored. */
export async function createAgent(userId: string, limits: AgentLimits): Promise<{ agent: AgentContext; apiKey: string }> {
  const apiKey = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { agent: await createAgentWithKey(userId, limits, apiKey), apiKey };
}

export async function createAgentWithKey(userId: string, input: Partial<AgentLimits> & { name: string }, apiKey: string) {
  const limits = AgentLimits.parse(input);
  const id = newId("agt");
  await query(
    `INSERT INTO agents (id, user_id, name, kind, key_hash, key_hint, weekly_budget, auto_pay_limit, allowed_categories, always_ask, status)
     VALUES ($1, $2, $3, 'external', $4, $5, $6, $7, $8, $9, 'active')`,
    [id, userId, limits.name, hashKey(apiKey), apiKey.slice(-4), limits.weeklyBudget, limits.autoPayLimit, jsonb(limits.allowedCategories), limits.alwaysAsk],
  );
  await audit(userId, "AGENT_CREATED", `Agent "${limits.name}" created${describeLimits(limits)}`);
  return (await getAgent(userId, id))!;
}

/** Adds a child (D-061). Their spending always has a weekly allowance and the kid-safe check. */
export async function createChild(userId: string, input: ChildInput): Promise<AgentContext> {
  const c = ChildInput.parse(input);
  if (await queryOne("SELECT 1 FROM agents WHERE login_name = $1", [c.loginName])) {
    throw new AgentInputError(`The username "${c.loginName}" is taken. Try another.`, 409);
  }
  const id = newId("agt");
  await query(
    `INSERT INTO agents (id, user_id, name, kind, login_name, password_hash, weekly_budget, auto_pay_limit, allowed_categories, always_ask, status)
     VALUES ($1, $2, $3, 'child', $4, $5, $6, $7, $8, $9, 'active')`,
    [id, userId, c.name, c.loginName, await hashPassword(c.password), c.weeklyBudget, c.autoPayLimit, jsonb(c.allowedCategories), c.alwaysAsk],
  );
  await audit(userId, "CHILD_ADDED", `Child "${c.name}" added (logs in as ${c.loginName})${describeLimits(c)}`);
  return (await getAgent(userId, id))!;
}

/** A child's login. Revoked children have no username/password left, so they never match. */
export async function childForLogin(loginName: string, password: string): Promise<AgentContext | null> {
  const parsed = LoginName.safeParse(loginName);
  if (!parsed.success) return null;
  const row = await queryOne<{ id: string; user_id: string; password_hash: string }>(
    "SELECT id, user_id, password_hash FROM agents WHERE login_name = $1 AND kind = 'child' AND status <> 'revoked' AND password_hash IS NOT NULL",
    [parsed.data],
  );
  if (!row || !(await verifyPassword(password, row.password_hash))) return null;
  await query("UPDATE agents SET last_used_at = now() WHERE id = $1", [row.id]);
  return getAgent(row.user_id, row.id);
}

export async function updateAgent(
  userId: string,
  agentId: string,
  patch: Partial<AgentLimits> & { status?: "active" | "paused"; password?: string },
) {
  const agent = await getAgent(userId, agentId);
  if (!agent || agent.status === "revoked") return null;
  const next = AgentLimits.parse({ ...agent, ...patch });
  if (agent.kind === "child" && next.weeklyBudget === null) throw new AgentInputError("A child always needs a weekly allowance.");
  if (agent.kind === "child" && patch.password !== undefined) {
    await query("UPDATE agents SET password_hash = $3 WHERE id = $1 AND user_id = $2", [agentId, userId, await hashPassword(ChildPassword.parse(patch.password))]);
    await query("DELETE FROM sessions WHERE agent_id = $1", [agentId]); // log the child out everywhere
    await audit(userId, "CHILD_PASSWORD_RESET", `New password set for "${agent.name}"`);
  }
  const status = agent.kind === "builtin" ? "active" : (patch.status ?? agent.status);
  await query(
    `UPDATE agents SET name = $3, weekly_budget = $4, auto_pay_limit = $5, allowed_categories = $6, always_ask = $7, status = $8
     WHERE id = $1 AND user_id = $2`,
    [agentId, userId, next.name, next.weeklyBudget, next.autoPayLimit, jsonb(next.allowedCategories), next.alwaysAsk, status],
  );
  const change = status !== agent.status ? (status === "paused" ? " paused" : " resumed") : ` updated${describeLimits(next)}`;
  await audit(userId, "AGENT_UPDATED", `${agent.kind === "child" ? "Child" : "Agent"} "${next.name}"${change}`);
  return getAgent(userId, agentId);
}

/**
 * Revoking is permanent: the key (or a child's login) stops working immediately and a child is
 * logged out. Past purchases stay in the ledger. The username is freed for reuse.
 */
export async function revokeAgent(userId: string, agentId: string): Promise<boolean> {
  const rows = await query<{ name: string; kind: Agent["kind"] }>(
    `UPDATE agents SET status = 'revoked', key_hash = NULL, login_name = NULL, password_hash = NULL
     WHERE id = $1 AND user_id = $2 AND kind IN ('external', 'child') AND status <> 'revoked' RETURNING name, kind`,
    [agentId, userId],
  );
  if (!rows[0]) return false;
  await query("DELETE FROM sessions WHERE agent_id = $1", [agentId]);
  await audit(
    userId,
    "AGENT_REVOKED",
    rows[0].kind === "child" ? `Removed "${rows[0].name}": they can no longer log in` : `Agent "${rows[0].name}" revoked: its key no longer works`,
  );
  return true;
}

/** Look up the agent behind an API key. Revoked keys are gone (hash cleared), so they never match. */
export async function agentForKey(apiKey: string): Promise<AgentContext | null> {
  if (!apiKey) return null;
  const row = await queryOne<AgentRow>(
    `UPDATE agents a SET last_used_at = now() WHERE a.key_hash = $1 AND a.status <> 'revoked'
     RETURNING ${COLS}, ${SPEND_SQL} AS spent_this_week`,
    [hashKey(apiKey)],
  );
  return row ? toAgent(row) : null;
}

export function describeLimits(l: Pick<AgentLimits, "weeklyBudget" | "autoPayLimit" | "allowedCategories" | "alwaysAsk">): string {
  const parts: string[] = [];
  if (l.weeklyBudget !== null) parts.push(`$${l.weeklyBudget}/week`);
  if (l.autoPayLimit !== null) parts.push(`auto-pay ≤ $${l.autoPayLimit}`);
  if (l.allowedCategories.length) parts.push(`only ${l.allowedCategories.join(", ")}`);
  if (l.alwaysAsk) parts.push("always ask");
  return parts.length ? `: ${parts.join(" · ")}` : ": no extra limits (your rules apply)";
}
