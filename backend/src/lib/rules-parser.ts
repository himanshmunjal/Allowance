import { z } from "zod";
import { json } from "./llm";
import { CATEGORIES, merchants } from "./catalog";
import { PolicySchema, type Policy } from "./policy";

// Turns "never spend more than $100 a week, ask me above $20" into a structured Policy.

const ParsedSchema = z.object({
  policy: PolicySchema,
  summary: z.string().describe("One sentence confirming the rules back to the user in plain English"),
});

export async function parseRules(text: string, current: Policy): Promise<{ policy: Policy; summary: string }> {
  const merchantList = merchants.map((m) => `- ${m.id}: ${m.name}${m.verified ? "" : " (unverified)"}`).join("\n");

  const { value } = await json({
    name: "spending_policy",
    schema: ParsedSchema,
    system: `You convert a user's plain-English spending rules for their AI shopping agent into a JSON policy.
Start from the current policy and change only what the user's text addresses. All amounts are USD.
Known categories: ${CATEGORIES.join(", ")}.
Known merchants (use these ids in allowedMerchants; an empty list means any merchant):
${merchantList}
If the user says "only buy from X", set allowedMerchants to those ids. If they say they trust a merchant, do not restrict the list.
autoApproveLimit must not exceed perPurchaseMax.
Category approvals: categoryAskAbove is ONLY for a category the user names together with its own amount; otherwise leave it as it is in the current policy (usually []). Never copy the general auto-pay limit into categoryAskAbove. "always ask me for X" → put X in approvalCategories. "Ask me for X over $N" / "only ask for X above $N" → add {category: X, amount: N} to categoryAskAbove AND remove X from approvalCategories. "Don't ask me for X anymore" → remove X from both.`,
    user: `<current_policy>${JSON.stringify(current)}</current_policy>\n<user_rules>${text}</user_rules>`,
  });
  return value;
}
