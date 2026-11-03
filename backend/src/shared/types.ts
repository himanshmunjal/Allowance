// API types shared by the backend and the frontend. The frontend imports this file type-only
// (alias @shared/*), so it must stay dependency-free: plain TypeScript types, no runtime code.

export type Category = "coffee" | "groceries" | "gifts" | "electronics" | "books" | "clothing" | "home" | "gambling" | "other";

export type Policy = {
  weeklyBudget: number;
  autoApproveLimit: number;
  perPurchaseMax: number;
  allowedMerchants: string[];
  blockedCategories: Category[];
  approvalCategories: Category[];
  /** Ask for approval in this category only above this amount (D-056), e.g. electronics over $50. */
  categoryAskAbove: { category: Category; amount: number }[];
  unverifiedMerchants: "block" | "approve" | "allow";
};

export type AiProviderInfo = { id: string; label: string; model: string };

export type TxStatus =
  | "PROCESSING"
  | "PAID"
  | "PENDING_APPROVAL"
  | "BLOCKED"
  | "REJECTED"
  | "REFUNDED"
  | "FAILED";

/**
 * chat = built-in agent, mcp = external agent, store = a store's "Pay with Allowance" checkout (D-060),
 * sample = made-up history in a demo account (D-067), lab = an Attack Lab run, never in a real ledger (D-065).
 */
export type TxSource = "chat" | "mcp" | "store" | "sample" | "lab";

export type RiskLevel = "low" | "medium" | "high";

/** One step of a purchase's decision timeline (D-058), in the order the pipeline ran them. */
export type DecisionCheck = {
  step: "price" | "rules" | "agent" | "child" | "injection" | "wallet" | "velocity" | "risk" | "recheck" | "decision";
  label: string;
  outcome: "pass" | "ask" | "block" | "skip";
  detail: string;
};

export type Transaction = {
  id: string;
  userId: string;
  /** The agent that asked for it (D-054); null only for purchases from before agents existed. */
  agentId: string | null;
  agentName: string | null;
  source: TxSource;
  status: TxStatus;
  merchantId: string;
  merchantName: string;
  productId: string;
  title: string;
  /** Rule category; null for purchases from before it was recorded. */
  category: string | null;
  quantity: number;
  unitPrice: number;
  amount: number;
  currency: string;
  userIntent: string;
  agentReason: string;
  decisionReasons: string[];
  /** Decision timeline; empty for purchases made before it existed. */
  checks: DecisionCheck[];
  riskLevel: RiskLevel | null;
  riskReason: string | null;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  paypalRefundId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuditEvent = {
  id: number;
  txId: string | null;
  type: string;
  message: string;
  data: unknown;
  createdAt: string;
};

/** demo = a throwaway one-click account (D-067): sandbox money, deleted after 24 hours. */
export type User = { id: string; email: string; demo?: boolean };

/** Who is logged in (D-061): the account owner (a parent), or one of their children. */
export type Me = { user: User; role: "owner" | "child"; child: Agent | null };

export type AgentStatus = "active" | "paused" | "revoked";

/**
 * One agent's allowance (D-054). Limits are on top of the user's own rules; null = no extra limit.
 * A "child" (D-061) is a person, not a bot: they log in with a username and password the parent set.
 */
export type Agent = {
  id: string;
  name: string;
  kind: "builtin" | "external" | "child";
  /** Child's username for logging in; null for bots. */
  loginName: string | null;
  /** Last 4 characters of the API key (the key itself is shown once, at creation). */
  keyHint: string | null;
  weeklyBudget: number | null;
  autoPayLimit: number | null;
  /** Empty = any category the user's rules allow. */
  allowedCategories: Category[];
  alwaysAsk: boolean;
  status: AgentStatus;
  createdAt: string;
  lastUsedAt: string | null;
  /** Rolling 7-day spend by this agent, including purchases awaiting approval. */
  spentThisWeek: number;
};

export type WalletStatus = "DISCONNECTED" | "PENDING" | "CONNECTED";

export type Wallet = {
  status: WalletStatus;
  payerEmail: string | null;
};

export type SpendSummary = {
  weeklyBudget: number;
  spent: number;
  pending: number;
  remaining: number;
};

export type PurchaseResult = {
  /** PROCESSING: PayPal's answer was lost; it may have been charged, and is being confirmed (D-062). */
  status: "PAID" | "PENDING_APPROVAL" | "BLOCKED" | "FAILED" | "PROCESSING";
  transactionId: string;
  title: string;
  merchant: string;
  amount: number;
  currency: string;
  reasons: string[];
  approvalUrl?: string;
};

export type AgentStep = {
  tool: string;
  input: unknown;
  output: unknown;
};

/** One Attack Lab scenario (D-065), run live against the real pipeline in a throwaway account. */
export type AttackResult = {
  id: string;
  title: string;
  /** What the attacker tries, in one sentence. */
  attack: string;
  /** What must happen for this to count as stopped. */
  expected: string;
  /** What actually happened. */
  outcome: string;
  defended: boolean;
  /** "code": rules and locks alone, with the AI reviewer rigged to approve everything. "ai": the real reviewer. */
  layer: "code" | "ai";
  /** Simulated dollars the attacker got through without a human. */
  autoPaid: number;
  checks: DecisionCheck[];
};

export type AttackReport = {
  results: AttackResult[];
  defended: number;
  total: number;
  ranAt: string;
};

/** A rule change the advisor suggests from the user's own decisions (D-068). Applying it is the user's call. */
export type RuleSuggestion = {
  id: string;
  kind: "loosen" | "tighten";
  title: string;
  evidence: string;
  explanation: string;
};

/** The AI explorer's reading of a question about the ledger (D-066): a view, never data. */
export type LedgerView = {
  statuses: TxStatus[];
  agents: string[];
  merchant: string | null;
  category: string | null;
  minAmount: number | null;
  maxAmount: number | null;
  sinceDays: number | null;
  sortBy: "createdAt" | "amount" | "merchantName" | "agentName" | "status";
  sortDir: "asc" | "desc";
  summary: string;
};

/** A ledger row checked against PayPal's own record (D-066). */
export type ReconcileRow = {
  id: string;
  matches: boolean;
  paypalStatus: string | null;
  paypalAmount: number | null;
  note: string;
};
