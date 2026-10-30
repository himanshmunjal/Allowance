import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { CATEGORIES } from "./categories";
import { audit, jsonb, newId, query, queryOne, type Queryable } from "./db";
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

type AgentRow = {
  id: string;
  user_id: string;
  name: string;
  kind: Agent["kind"];
  key_hint: string | null;
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

export function publicAgent(a: AgentContext): Agent {
  const { userId: _userId, ...rest } = a;
  return rest;
}

export async function listAgents(userId: string): Promise<AgentContext[]> {
  const rows = await query<AgentRow>(
    `SELECT a.*, ${SPEND_SQL} AS spent_this_week FROM agents a
     WHERE a.user_id = $1 AND a.status <> 'revoked' ORDER BY (a.kind = 'builtin') DESC, a.created_at`,
    [userId],
  );
  return rows.map(toAgent);
}

export async function getAgent(userId: string, agentId: string, on?: Queryable): Promise<AgentContext | null> {
  const row = await queryOne<AgentRow>(
    `SELECT a.*, ${SPEND_SQL} AS spent_this_week FROM agents a WHERE a.id = $1 AND a.user_id = $2`,
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

export async function updateAgent(userId: string, agentId: string, patch: Partial<AgentLimits> & { status?: "active" | "paused" }) {
  const agent = await getAgent(userId, agentId);
  if (!agent || agent.status === "revoked") return null;
  const next = AgentLimits.parse({ ...agent, ...patch });
  const status = agent.kind === "builtin" ? "active" : (patch.status ?? agent.status);
  await query(
    `UPDATE agents SET name = $3, weekly_budget = $4, auto_pay_limit = $5, allowed_categories = $6, always_ask = $7, status = $8
     WHERE id = $1 AND user_id = $2`,
    [agentId, userId, next.name, next.weeklyBudget, next.autoPayLimit, jsonb(next.allowedCategories), next.alwaysAsk, status],
  );
  const change = status !== agent.status ? (status === "paused" ? " paused" : " resumed") : ` updated${describeLimits(next)}`;
  await audit(userId, "AGENT_UPDATED", `Agent "${next.name}"${change}`);
  return getAgent(userId, agentId);
}

/** Revoking is permanent: the key stops working immediately. Past purchases stay in the ledger. */
export async function revokeAgent(userId: string, agentId: string): Promise<boolean> {
  const rows = await query<{ name: string }>(
    "UPDATE agents SET status = 'revoked', key_hash = NULL WHERE id = $1 AND user_id = $2 AND kind = 'external' AND status <> 'revoked' RETURNING name",
    [agentId, userId],
  );
  if (rows[0]) await audit(userId, "AGENT_REVOKED", `Agent "${rows[0].name}" revoked: its key no longer works`);
  return rows.length > 0;
}

/** Look up the agent behind an API key. Revoked keys are gone (hash cleared), so they never match. */
export async function agentForKey(apiKey: string): Promise<AgentContext | null> {
  if (!apiKey) return null;
  const row = await queryOne<AgentRow>(
    `UPDATE agents a SET last_used_at = now() WHERE a.key_hash = $1 AND a.status <> 'revoked'
     RETURNING a.*, ${SPEND_SQL} AS spent_this_week`,
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
