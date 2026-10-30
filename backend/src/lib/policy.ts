import { z } from "zod";
import { merchants, type Merchant, type Product } from "./catalog";
import { CATEGORIES } from "./categories";
import { audit, jsonb, query, queryOne, type Queryable } from "./db";
import type { AgentContext } from "./agents";
import type { Policy, SpendSummary } from "../shared/types";

// Deterministic rules. The AI can make a decision stricter, never looser (DECISION.md D-005).

export const PolicySchema = z.object({
  weeklyBudget: z.number().describe("Max total spend in a rolling 7-day window, USD"),
  autoApproveLimit: z.number().describe("Purchases at or below this amount may be paid automatically, USD"),
  perPurchaseMax: z.number().describe("Hard cap for a single purchase, USD; anything above is blocked"),
  allowedMerchants: z
    .array(z.string())
    .describe("Merchant ids the agent may buy from. Empty array = any merchant (subject to unverifiedMerchants)"),
  blockedCategories: z.array(z.enum(CATEGORIES)).describe("Categories that are always blocked"),
  approvalCategories: z.array(z.enum(CATEGORIES)).describe("Categories that ALWAYS need human approval, at any price"),
  categoryAskAbove: z
    .array(z.object({ category: z.enum(CATEGORIES), amount: z.number().describe("USD") }))
    .describe("Per-category approval thresholds: purchases in that category above the amount need approval (e.g. electronics over $50). At or below it, the normal auto-pay limit applies"),
  unverifiedMerchants: z.enum(["block", "approve", "allow"]).describe("How to treat merchants that are not verified"),
}) satisfies z.ZodType<Policy>; // compile-time check: the schema matches the shared API type

export type { Policy };

export const DEFAULT_POLICY: Policy = {
  weeklyBudget: 150,
  autoApproveLimit: 25,
  perPurchaseMax: 100,
  allowedMerchants: [],
  blockedCategories: ["gambling"],
  approvalCategories: ["electronics"],
  categoryAskAbove: [],
  unverifiedMerchants: "block",
};

export const DEFAULT_POLICY_TEXT =
  "Spend at most $150 a week. Pay automatically for anything up to $25, ask me above that, and never spend more than $100 on one thing. Always ask before buying electronics. Never buy gambling credits and never buy from unverified sellers.";

/** The user's rules (D-053); new accounts start with the defaults. */
export async function getPolicy(userId: string): Promise<{ policy: Policy; sourceText: string }> {
  const row = await queryOne<{ policy: unknown; source_text: string | null }>(
    "SELECT policy, source_text FROM policies WHERE user_id = $1",
    [userId],
  );
  if (!row) return { policy: DEFAULT_POLICY, sourceText: DEFAULT_POLICY_TEXT };
  // Rules saved before a field existed get its default (e.g. categoryAskAbove, D-056).
  return { policy: PolicySchema.parse({ ...DEFAULT_POLICY, ...(row.policy as object) }), sourceText: row.source_text ?? "" };
}

export async function savePolicy(userId: string, policy: Policy, sourceText?: string): Promise<Policy> {
  const clean = sanitizePolicy(policy);
  await query(
    `INSERT INTO policies (user_id, policy, source_text) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET policy = excluded.policy,
       source_text = COALESCE(excluded.source_text, policies.source_text), updated_at = now()`,
    [userId, jsonb(clean), sourceText ?? null],
  );
  await audit(userId, "POLICY_UPDATED", describePolicy(clean), null, clean);
  return clean;
}

// Keep values sane whatever the UI or the rule parser sends.
function sanitizePolicy(p: Policy): Policy {
  const money = (n: number) => Math.max(0, Math.round(n * 100) / 100);
  const known = new Set(merchants.map((m) => m.id));
  return {
    ...p,
    weeklyBudget: money(p.weeklyBudget),
    perPurchaseMax: money(p.perPurchaseMax),
    autoApproveLimit: Math.min(money(p.autoApproveLimit), money(p.perPurchaseMax)),
    allowedMerchants: [...new Set(p.allowedMerchants.filter((id) => known.has(id)))],
    blockedCategories: [...new Set(p.blockedCategories)],
    // A threshold for a category is the more specific rule, so it replaces "always ask" for it.
    approvalCategories: [...new Set(p.approvalCategories)].filter((c) => !p.categoryAskAbove.some((t) => t.category === c)),
    categoryAskAbove: [...new Map(p.categoryAskAbove.map((t) => [t.category, { category: t.category, amount: money(t.amount) }])).values()],
  };
}

export function describePolicy(p: Policy): string {
  const parts = [
    `$${p.weeklyBudget}/week`,
    `auto-pay ≤ $${p.autoApproveLimit}`,
    `max $${p.perPurchaseMax} per purchase`,
  ];
  if (p.blockedCategories.length) parts.push(`blocked: ${p.blockedCategories.join(", ")}`);
  if (p.approvalCategories.length) parts.push(`always ask: ${p.approvalCategories.join(", ")}`);
  for (const t of p.categoryAskAbove) parts.push(`ask for ${t.category} over $${t.amount}`);
  parts.push(`unverified sellers: ${p.unverifiedMerchants}`);
  return parts.join(" · ");
}

// Rolling 7-day spend. Pending approvals count too, so the agent can't queue up more than the budget.
export async function spendSummary(userId: string, policy: Policy, on?: Queryable): Promise<SpendSummary> {
  const rows = await query<{ status: string; total: number }>(
    `SELECT status, COALESCE(SUM(amount), 0) AS total FROM transactions
     WHERE user_id = $1 AND created_at >= now() - interval '7 days' AND status IN ('PROCESSING', 'PAID', 'PENDING_APPROVAL')
     GROUP BY status`,
    [userId],
    on,
  );
  const spent = rows.filter((r) => r.status !== "PENDING_APPROVAL").reduce((sum, r) => sum + r.total, 0);
  const pending = rows.find((r) => r.status === "PENDING_APPROVAL")?.total ?? 0;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    weeklyBudget: policy.weeklyBudget,
    spent: round(spent),
    pending: round(pending),
    remaining: round(Math.max(0, policy.weeklyBudget - spent - pending)),
  };
}

export type Verdict = "ALLOW" | "NEEDS_APPROVAL" | "BLOCK";

export type PolicyResult = { verdict: Verdict; reasons: string[] };

const rank: Record<Verdict, number> = { ALLOW: 0, NEEDS_APPROVAL: 1, BLOCK: 2 };

export function stricter(a: Verdict, b: Verdict): Verdict {
  return rank[a] >= rank[b] ? a : b;
}

export function evaluatePolicy(
  policy: Policy,
  spend: SpendSummary,
  candidate: { product: Product; merchant: Merchant; amount: number },
  agent?: AgentContext,
): PolicyResult {
  const { product, merchant, amount } = candidate;
  const money = (n: number) => `$${n.toFixed(2)}`;
  const blocks: string[] = [];
  const asks: string[] = [];
  const passes: string[] = [];

  if (policy.allowedMerchants.length > 0 && !policy.allowedMerchants.includes(merchant.id)) {
    blocks.push(`${merchant.name} is not on your allowed-merchant list`);
  }
  if (!merchant.verified) {
    if (policy.unverifiedMerchants === "block") blocks.push(`${merchant.name} is an unverified seller`);
    else if (policy.unverifiedMerchants === "approve") asks.push(`${merchant.name} is an unverified seller`);
  }
  if (policy.blockedCategories.includes(product.category as Policy["blockedCategories"][number])) {
    blocks.push(`"${product.category}" is a blocked category`);
  }
  if (amount > policy.perPurchaseMax) {
    blocks.push(`${money(amount)} is over your ${money(policy.perPurchaseMax)} per-purchase cap`);
  }
  if (amount > spend.remaining) {
    blocks.push(`${money(amount)} exceeds the ${money(spend.remaining)} left in this week's budget`);
  } else {
    passes.push(`Fits the weekly budget (${money(spend.remaining - amount)} left after this)`);
  }
  if (policy.approvalCategories.includes(product.category as Policy["approvalCategories"][number])) {
    asks.push(`You asked to approve every "${product.category}" purchase`);
  }
  const threshold = policy.categoryAskAbove.find((t) => t.category === product.category);
  if (threshold) {
    if (amount > threshold.amount) asks.push(`You asked to approve "${product.category}" purchases over ${money(threshold.amount)}`);
    else passes.push(`Under your ${money(threshold.amount)} approval threshold for "${product.category}"`);
  }
  if (amount > policy.autoApproveLimit) {
    asks.push(`${money(amount)} is above your ${money(policy.autoApproveLimit)} auto-pay limit`);
  } else {
    passes.push(`Within your ${money(policy.autoApproveLimit)} auto-pay limit`);
  }

  // The agent's own allowance (D-054): only ever stricter than the user's rules.
  if (agent) {
    const who = `"${agent.name}"`;
    if (agent.status !== "active") blocks.push(`Agent ${who} is paused`);
    if (agent.allowedCategories.length && !agent.allowedCategories.includes(product.category as Policy["blockedCategories"][number])) {
      blocks.push(`Agent ${who} may only buy ${agent.allowedCategories.join(", ")}`);
    }
    if (agent.weeklyBudget !== null) {
      const left = Math.max(0, agent.weeklyBudget - agent.spentThisWeek);
      if (amount > left) blocks.push(`${money(amount)} exceeds the ${money(left)} left in ${who}'s ${money(agent.weeklyBudget)} weekly allowance`);
      else passes.push(`Fits ${who}'s weekly allowance (${money(left - amount)} left after this)`);
    }
    if (agent.alwaysAsk) asks.push(`You asked to approve every purchase by ${who}`);
    if (agent.autoPayLimit !== null && amount > agent.autoPayLimit && amount <= policy.autoApproveLimit) {
      asks.push(`${money(amount)} is above ${who}'s ${money(agent.autoPayLimit)} auto-pay limit`);
    }
  }

  if (blocks.length) return { verdict: "BLOCK", reasons: blocks };
  if (asks.length) return { verdict: "NEEDS_APPROVAL", reasons: asks };
  return { verdict: "ALLOW", reasons: passes };
}
