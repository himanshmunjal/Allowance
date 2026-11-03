import { z } from "zod";
import { query } from "./db";
import { describePolicy, getPolicy, savePolicy } from "./policy";
import { json } from "./llm";
import type { Category, Policy, RuleSuggestion } from "../shared/types";

// Rule advisor (DECISION.md D-068): your decisions become suggested rules. The numbers are counted in
// code; the AI only explains them, and a suggestion changes nothing until the owner clicks Apply.
// Only counts reach the model, never listing text, so a seller can't talk it into loosening a rule.

const WINDOW_DAYS = 60;
const MIN_EVIDENCE = 3;
const MIN_REGRET = 2;

export type Decision = { category: string | null; amount: number; status: string; approved: boolean; rejected: boolean };

export type Proposal = { id: string; kind: RuleSuggestion["kind"]; title: string; evidence: string; sentence: string; next: Policy };

const money = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Pure: decisions + rules → proposals, tightening first. Unknown-category purchases count only toward the general limit. */
export function propose(policy: Policy, decisions: Decision[]): Proposal[] {
  const out: Proposal[] = [];
  const inCategory = (c: string) => decisions.filter((d) => d.category === c);

  // Tighten: you keep saying no to, or undoing, an agent's purchases in a category.
  const categories = [...new Set(decisions.map((d) => d.category).filter((c): c is string => !!c))];
  for (const category of categories) {
    const list = inCategory(category);
    const regrets = list.filter((d) => d.rejected || d.status === "REFUNDED").length;
    const approved = list.filter((d) => d.approved && d.status !== "REFUNDED").length;
    if (regrets >= MIN_REGRET && regrets > approved && !policy.approvalCategories.includes(category as Category) && !policy.blockedCategories.includes(category as Category)) {
      out.push({
        id: `tighten:${category}`,
        kind: "tighten",
        title: `Always ask before buying ${category}`,
        evidence: `You rejected or refunded ${plural(regrets, "purchase")} in ${category}, and kept ${approved}.`,
        sentence: `Always ask before buying ${category}.`,
        next: { ...policy, approvalCategories: [...policy.approvalCategories, category as Category], categoryAskAbove: policy.categoryAskAbove.filter((t) => t.category !== category) },
      });
    }
  }

  // Loosen: you approve every purchase in an always-ask category.
  for (const category of policy.approvalCategories) {
    const list = inCategory(category);
    const approved = list.filter((d) => d.approved && d.status !== "REFUNDED");
    if (approved.length >= MIN_EVIDENCE && !list.some((d) => d.rejected || d.status === "REFUNDED")) {
      out.push({
        id: `loosen-category:${category}`,
        kind: "loosen",
        title: `Stop always asking for ${category} under ${money(policy.autoApproveLimit)}`,
        evidence: `You approved all ${approved.length} ${category} purchases, none rejected or refunded. Anything over your auto-pay limit still asks.`,
        sentence: `Don't always ask for ${category}: my normal auto-pay limit applies.`,
        next: { ...policy, approvalCategories: policy.approvalCategories.filter((c) => c !== category) },
      });
    }
  }

  // Loosen: you keep approving amounts just above the auto-pay limit.
  const aboveLimit = decisions.filter((d) => d.amount > policy.autoApproveLimit);
  const kept = aboveLimit.filter((d) => d.approved && d.status !== "REFUNDED");
  if (kept.length >= MIN_EVIDENCE && !aboveLimit.some((d) => d.rejected || (d.approved && d.status === "REFUNDED"))) {
    const limit = Math.ceil(Math.max(...kept.map((d) => d.amount)));
    if (limit <= policy.perPurchaseMax && limit <= policy.weeklyBudget) {
      out.push({
        id: "loosen-limit",
        kind: "loosen",
        title: `Raise auto-pay from ${money(policy.autoApproveLimit)} to ${money(limit)}`,
        evidence: `You approved ${plural(kept.length, "purchase")} above your limit, up to ${money(limit)}, with none rejected or refunded.`,
        sentence: `Pay automatically for anything up to $${limit}.`,
        next: { ...policy, autoApproveLimit: limit },
      });
    }
  }
  return out.sort((a, b) => Number(b.kind === "tighten") - Number(a.kind === "tighten"));
}

async function proposalsFor(userId: string): Promise<{ proposals: Proposal[]; sourceText: string }> {
  const { policy, sourceText } = await getPolicy(userId);
  const rows = await query<{ category: string | null; amount: number; status: string; approved: boolean; rejected: boolean }>(
    `SELECT category, amount, status,
       decision_reasons ? 'Approved by you in PayPal' AS approved,
       decision_reasons ? 'Rejected by you' AS rejected
     FROM transactions WHERE user_id = $1 AND created_at >= now() - make_interval(days => $2)
       AND status IN ('PAID', 'REFUNDED', 'REJECTED')`,
    [userId, WINDOW_DAYS],
  );
  return { proposals: propose(policy, rows), sourceText };
}

const Explanations = z.object({ items: z.array(z.object({ id: z.string(), explanation: z.string() })) });

const SYSTEM = `You explain suggested spending-rule changes to the owner of an AI shopping agent. For each suggestion, write one friendly sentence (max 25 words) on what would change for them day to day, including the trade-off if the rule gets looser. Use only the facts given. Never invent numbers. Never tell them what to do.`;

export async function suggestions(userId: string): Promise<{ suggestions: RuleSuggestion[]; explainedBy: string | null }> {
  const { proposals } = await proposalsFor(userId);
  if (!proposals.length) return { suggestions: [], explainedBy: null };
  let explained = new Map<string, string>();
  let explainedBy: string | null = null;
  try {
    const { value, provider } = await json({
      name: "rule_explanations",
      system: SYSTEM,
      user: JSON.stringify(proposals.map(({ id, title, evidence, kind }) => ({ id, kind, title, evidence }))),
      schema: Explanations,
    });
    explained = new Map(value.items.map((i) => [i.id, i.explanation]));
    explainedBy = `${provider.label} (${provider.model})`;
  } catch (err) {
    console.warn("[advisor] explanations unavailable", (err as Error).message); // the counted facts still stand
  }
  return {
    explainedBy,
    suggestions: proposals.map((p) => ({ id: p.id, kind: p.kind, title: p.title, evidence: p.evidence, explanation: explained.get(p.id) ?? "" })),
  };
}

/** Re-derives the proposal on the server, so a client can only apply what the evidence supports right now. */
export async function applySuggestion(userId: string, id: string): Promise<{ policy: Policy; summary: string; sourceText: string } | null> {
  const { proposals, sourceText } = await proposalsFor(userId);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) return null;
  const nextText = `${sourceText} ${proposal.sentence}`.trim();
  const policy = await savePolicy(userId, proposal.next, nextText);
  return { policy, summary: describePolicy(policy), sourceText: nextText };
}
