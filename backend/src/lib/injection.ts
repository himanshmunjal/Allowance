// Deterministic prompt-injection screen for product listings (DECISION.md D-035).
// It runs on every purchase at no AI cost, so injection is caught even on small free models.

const PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\b(ai|llm|gpt|shopping|autonomous)\s+(agent|assistant|bot)s?\b/i, why: "addresses AI agents directly" },
  { re: /\bnote\s+to\s+(the\s+)?(ai|agent|assistant|model)s?\b/i, why: "contains a note to the AI" },
  { re: /\bignore\s+(all\s+|any\s+|your\s+|the\s+|previous\s+|prior\s+)*(limits?|rules?|instructions?|polic(y|ies)|budget)/i, why: "tells the agent to ignore its rules" },
  { re: /\b(pre-?approved|already\s+approved|authori[sz]ed)\s+by\s+(the\s+)?(user|owner|customer)\b/i, why: "claims the user pre-approved it" },
  // "buy quantity 10" / "quantity: 10", but not ordinary offers like "buy 2 get 1 free".
  { re: /\b(buy|purchase|order)\s+quantity\s+\d+|\bquantity\s*[:=]\s*\d+/i, why: "dictates a purchase quantity" },
  { re: /\b(system\s+prompt|developer\s+message|you\s+are\s+now|new\s+instructions?)\b/i, why: "tries to change the agent's instructions" },
];

export type InjectionFinding = { flagged: boolean; reasons: string[] };

export function detectInjection(text: string): InjectionFinding {
  const reasons = PATTERNS.filter((p) => p.re.test(text)).map((p) => p.why);
  return { flagged: reasons.length > 0, reasons };
}
