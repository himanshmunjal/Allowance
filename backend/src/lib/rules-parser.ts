import { z } from "zod";
import { json } from "./llm";
import { CATEGORIES, merchants } from "./catalog";
import { PolicySchema, type Policy } from "./policy";

// Turns "never spend more than $100 a week, ask me above $20" into a structured Policy.
//
// The confirmation shown to the user is built in code from what actually changed, not taken from
// the model: the model's own summary sometimes promised rules it never put in the policy (e.g.
// "ask me for clothes over $40" summarised but missing from categoryAskAbove).

const ParsedSchema = z.object({
  policy: PolicySchema,
  notApplied: z
    .array(z.string())
    .describe("Each part of the user's text that could not be expressed with the known categories/merchants, quoted briefly"),
});

const money = (n: number) => `$${n}`;
const list = (xs: string[]) => xs.join(", ");

/** Plain-English list of what changed between two policies. */
export function describeChanges(before: Policy, after: Policy): string[] {
  const out: string[] = [];
  if (before.weeklyBudget !== after.weeklyBudget) out.push(`weekly budget ${money(after.weeklyBudget)}`);
  if (before.autoApproveLimit !== after.autoApproveLimit) out.push(`auto-pay up to ${money(after.autoApproveLimit)}`);
  if (before.perPurchaseMax !== after.perPurchaseMax) out.push(`max ${money(after.perPurchaseMax)} per purchase`);

  const diff = (a: string[], b: string[]) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) });
  const blocked = diff(before.blockedCategories, after.blockedCategories);
  if (blocked.added.length) out.push(`blocked ${list(blocked.added)}`);
  if (blocked.removed.length) out.push(`unblocked ${list(blocked.removed)}`);
  const always = diff(before.approvalCategories, after.approvalCategories);
  if (always.added.length) out.push(`always ask for ${list(always.added)}`);
  if (always.removed.length) out.push(`stopped always asking for ${list(always.removed)}`);

  const key = (t: { category: string; amount: number }) => `${t.category}:${t.amount}`;
  const beforeAsk = new Set(before.categoryAskAbove.map(key));
  const afterCats = new Set(after.categoryAskAbove.map((t) => t.category));
  for (const t of after.categoryAskAbove) if (!beforeAsk.has(key(t))) out.push(`ask for ${t.category} over ${money(t.amount)}`);
  for (const t of before.categoryAskAbove) if (!afterCats.has(t.category)) out.push(`removed the ${t.category} threshold`);

  if (before.unverifiedMerchants !== after.unverifiedMerchants) out.push(`unverified sellers: ${after.unverifiedMerchants}`);
  const m = diff(before.allowedMerchants, after.allowedMerchants);
  if (m.added.length || m.removed.length) {
    const names = after.allowedMerchants.map((id) => merchants.find((x) => x.id === id)?.name ?? id);
    out.push(names.length ? `only buy from ${list(names)}` : "any merchant allowed");
  }
  return out;
}

export async function parseRules(
  text: string,
  current: Policy,
): Promise<{ policy: Policy; summary: string; notApplied: string[] }> {
  const merchantList = merchants.map((m) => `- ${m.id}: ${m.name}${m.verified ? "" : " (unverified)"}`).join("\n");

  const { value } = await json({
    name: "spending_policy",
    schema: ParsedSchema,
    system: `You convert a user's plain-English spending rules for their AI shopping agent into a JSON policy.
Start from the current policy and change only what the user's text addresses. All amounts are USD.
Every rule in the user's text must be reflected in the policy: go through the text sentence by sentence and check each one is applied.
Known categories: ${CATEGORIES.join(", ")}.
Map a thing to a category only when it clearly belongs there (clothes/shoes → clothing, laptops/phones/video games → electronics). Never map something to "other" just because no category fits; put it in notApplied instead (e.g. "toys").
Known merchants (use these ids in allowedMerchants; an empty list means any merchant):
${merchantList}
If the user says "only buy from X", set allowedMerchants to those ids. If they say they trust a merchant, do not restrict the list.
autoApproveLimit must not exceed perPurchaseMax.
Category approvals: categoryAskAbove is ONLY for a category the user names together with its own amount; otherwise leave it as it is in the current policy (usually []). Never copy the general auto-pay limit into categoryAskAbove. "always ask me for X" → put X in approvalCategories. "Ask me for X over $N" / "only ask for X above $N" / "allow X under $N without asking" → add {category: X, amount: N} to categoryAskAbove AND remove X from approvalCategories. "Don't ask me for X anymore" → remove X from both.
notApplied: an empty list unless part of the text could not be expressed.`,
    user: `<current_policy>${JSON.stringify(current)}</current_policy>\n<user_rules>${text}</user_rules>`,
  });

  const { policy, notApplied } = value;
  const changes = describeChanges(current, policy);
  let summary = changes.length ? `Updated: ${changes.join("; ")}.` : "No changes: your rules already match this.";
  if (notApplied.length) summary += ` Couldn't apply: ${notApplied.join("; ")} (no matching category or merchant).`;
  return { policy, summary, notApplied };
}
