import { query, type Queryable } from "./db";
import type { AgentContext } from "./agents";
import type { Policy, TxStatus } from "../shared/types";

// Velocity guard (DECISION.md D-064). The agent is TOLD not to retry or split purchases; this makes
// it true whatever the model does. An LLM that retries a tool call must not pay twice, and ten $20
// purchases must not slip past a $25 auto-pay limit. These only ever ask a human: they never block.

export const DUPLICATE_WINDOW_MIN = 10;
export const SPLIT_WINDOW_MIN = 60;
export const BURST_WINDOW_MIN = 10;
export const BURST_MAX = 5;

export type RecentPurchase = {
  productId: string;
  merchantId: string;
  amount: number;
  status: TxStatus;
  /** A person approved it in PayPal, so it says nothing about what the agent did on its own. */
  humanApproved: boolean;
  minutesAgo: number;
};

const LIVE: TxStatus[] = ["PROCESSING", "PAID", "PENDING_APPROVAL"];
const AUTO_PAID: TxStatus[] = ["PROCESSING", "PAID"];

/** Pure, so it can be tested without a database. Returns the reasons a human should look. */
export function evaluateVelocity(
  recent: RecentPurchase[],
  candidate: { productId: string; merchantId: string; merchantName: string; title: string; amount: number },
  autoPayLimit: number,
): string[] {
  const reasons: string[] = [];
  const money = (n: number) => `$${n.toFixed(2)}`;

  const duplicate = recent.find((r) => r.productId === candidate.productId && LIVE.includes(r.status) && r.minutesAgo <= DUPLICATE_WINDOW_MIN);
  if (duplicate) {
    reasons.push(`This agent already ${duplicate.status === "PENDING_APPROVAL" ? "requested" : "bought"} "${candidate.title}" ${Math.round(duplicate.minutesAgo)} min ago: this could be an accidental retry`);
  }

  const auto = recent.filter((r) => AUTO_PAID.includes(r.status) && !r.humanApproved);
  const sameMerchant = auto.filter((r) => r.merchantId === candidate.merchantId && r.minutesAgo <= SPLIT_WINDOW_MIN);
  const total = sameMerchant.reduce((sum, r) => sum + r.amount, candidate.amount);
  if (sameMerchant.length && total > autoPayLimit) {
    reasons.push(`With ${sameMerchant.length} recent auto-payment${sameMerchant.length > 1 ? "s" : ""} to ${candidate.merchantName}, this makes ${money(total)} in an hour, over your ${money(autoPayLimit)} auto-pay limit: it could be one purchase split into small ones`);
  }

  const burst = auto.filter((r) => r.minutesAgo <= BURST_WINDOW_MIN).length;
  if (burst >= BURST_MAX) {
    reasons.push(`This agent auto-paid ${burst} times in ${BURST_WINDOW_MIN} minutes: unusually fast`);
  }
  return reasons;
}

/** The limit that actually decides auto-pay for this agent: its own, if tighter than the user's. */
export const effectiveAutoLimit = (policy: Policy, agent: AgentContext) =>
  agent.autoPayLimit === null ? policy.autoApproveLimit : Math.min(policy.autoApproveLimit, agent.autoPayLimit);

export async function recentPurchases(agentId: string, on?: Queryable): Promise<RecentPurchase[]> {
  const rows = await query<{ product_id: string; merchant_id: string; amount: number; status: TxStatus; approved: boolean; minutes_ago: number }>(
    `SELECT product_id, merchant_id, amount, status,
       decision_reasons ? 'Approved by you in PayPal' AS approved,
       EXTRACT(EPOCH FROM now() - created_at)::float8 / 60 AS minutes_ago
     FROM transactions
     WHERE agent_id = $1 AND created_at >= now() - make_interval(mins => $2) AND status = ANY($3)`,
    [agentId, Math.max(DUPLICATE_WINDOW_MIN, SPLIT_WINDOW_MIN, BURST_WINDOW_MIN), LIVE],
    on,
  );
  return rows.map((r) => ({
    productId: r.product_id,
    merchantId: r.merchant_id,
    amount: r.amount,
    status: r.status,
    humanApproved: r.approved,
    minutesAgo: r.minutes_ago,
  }));
}
