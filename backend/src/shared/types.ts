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

/** chat = built-in agent, mcp = external agent, store = a store's "Pay with Allowance" checkout (D-060). */
export type TxSource = "chat" | "mcp" | "store";

export type RiskLevel = "low" | "medium" | "high";

/** One step of a purchase's decision timeline (D-058), in the order the pipeline ran them. */
export type DecisionCheck = {
  step: "price" | "rules" | "agent" | "injection" | "wallet" | "risk" | "recheck" | "decision";
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

export type User = { id: string; email: string };

export type AgentStatus = "active" | "paused" | "revoked";

/** One agent's allowance (D-054). Limits are on top of the user's own rules; null = no extra limit. */
export type Agent = {
  id: string;
  name: string;
  kind: "builtin" | "external";
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
  status: "PAID" | "PENDING_APPROVAL" | "BLOCKED" | "FAILED";
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
