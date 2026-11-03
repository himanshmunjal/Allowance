import type { Product } from "./catalog";

// Kid-safe check (DECISION.md D-061). Runs on every purchase by a child, after the parent's rules
// and the child's allowance. It can't be switched off: age-restricted goods are blocked for children
// whatever the parent's rules say. Free and deterministic, like the injection screen (D-035).

const RESTRICTED: { re: RegExp; what: string }[] = [
  { re: /\b(alcohol(ic)?|(?<!root |ginger )beer|wine|vodka|whiske?y|bourbon|tequila|liquor|liqueur|champagne|prosecco|hard seltzer|\brum\b|\bgin\b)\b/i, what: "alcohol" },
  { re: /\b(tobacco|cigar(ette)?s?|nicotine|vape|vaping|e-?cig(arette)?s?|e-?liquid|juul|hookah|rolling papers?)\b/i, what: "tobacco or vaping" },
  { re: /\b(cannabis|marijuana|thc|cbd|kratom)\b/i, what: "cannabis or drugs" },
  { re: /\b(casino|gambling|sportsbook|betting|poker chips|slot credits|lottery)\b/i, what: "gambling" },
  { re: /\b(firearms?|handguns?|rifles?|shotguns?|ammunition|ammo|switchblade|(hunting|tactical|butterfly) knife)\b/i, what: "weapons" },
  { re: /\b(adult toy|sex toy|lingerie|erotic|xxx|pornograph\w*|adults? only|mature content)\b/i, what: "adult content" },
];

export type ChildSafety = { blocked: boolean; found: string[] };

export function checkChildSafety(product: Pick<Product, "name" | "description" | "category">): ChildSafety {
  const text = `${product.name}\n${product.description}`;
  const found = RESTRICTED.filter((r) => r.re.test(text)).map((r) => r.what);
  if (product.category === "gambling" && !found.includes("gambling")) found.push("gambling");
  return { blocked: found.length > 0, found };
}
