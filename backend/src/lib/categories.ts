import type { Category } from "../shared/types";

// Rule categories, in their own module so catalog.ts, quotes.ts and policy.ts can share them
// without an import cycle.
export const CATEGORIES = [
  "coffee",
  "groceries",
  "gifts",
  "electronics",
  "books",
  "clothing",
  "home",
  "gambling",
  "other",
] as const satisfies readonly Category[];
