import { resolveProduct, type Product } from "./catalog";
import { Channel3Error } from "./channel3";
import { config } from "./config";
import { audit, getTransaction, insertTransaction, updateTransaction, withTransaction, type NewTransaction } from "./db";
import * as paypal from "./paypal";
import { evaluatePolicy, getPolicy, spendSummary, stricter, type StepResult, type Verdict } from "./policy";
import { detectInjection } from "./injection";
import { assessRisk, type RiskAssessment } from "./risk";
import { getAgent, type AgentContext } from "./agents";
import type { DecisionCheck, PurchaseResult, Transaction, TxSource } from "../shared/types";
import { getVaultId, setWalletConnected } from "./wallet";

// THE purchase pipeline. Every spend, from the chat agent or from an MCP client, goes through
// requestPurchase(). Nothing else in the codebase creates a payment for an agent (LLD §5).
// Everything is scoped to the agent's user: their rules, their budget, their PayPal wallet (D-053).

export class PurchaseInputError extends Error {}

export type PurchaseRequest = {
  agent: AgentContext;
  productId: string;
  quantity: number;
  userIntent: string;
  agentReason: string;
  source: TxSource;
};

const MAX_QUANTITY = 20;

export async function requestPurchase(req: PurchaseRequest): Promise<PurchaseResult> {
  const { userId } = req.agent;

  // 1. Resolve the product server-side. The agent supplies an id; price comes from the catalog
  // (for live Channel3 products: fetched again right now).
  let resolved: Awaited<ReturnType<typeof resolveProduct>>;
  try {
    resolved = await resolveProduct(req.productId);
  } catch (err) {
    if (!(err instanceof Channel3Error)) throw err;
    throw new PurchaseInputError(`Couldn't verify the live price right now (${err.message}). Nothing was bought; try again shortly.`);
  }
  if (!resolved) throw new PurchaseInputError(`Unknown or out-of-stock product id "${req.productId}". Use search_products first.`);
  const { product, merchant } = resolved;
  const quantity = Math.floor(req.quantity);
  if (!(quantity >= 1 && quantity <= MAX_QUANTITY)) {
    throw new PurchaseInputError(`Quantity must be between 1 and ${MAX_QUANTITY}.`);
  }
  const amount = Math.round(product.price * quantity * 100) / 100;
  const { policy } = await getPolicy(userId);

  // 2-3. Deterministic rules first (the user's, then the agent's allowance): a blocked purchase
  // never reaches the AI or PayPal.
  const rules = evaluatePolicy(policy, await spendSummary(userId, policy), { product, merchant, amount }, req.agent);

  // Decision timeline (D-058): every step the pipeline runs, in order, for the ledger and approval page.
  const checks: DecisionCheck[] = [
    {
      step: "price",
      label: "Price verified",
      outcome: "pass",
      detail: `${fmt(product.price)}${quantity > 1 ? ` × ${quantity} = ${fmt(amount)}` : ""} · ${PRICE_SOURCE[product.source ?? "demo"]}`,
    },
    stepCheck("rules", "Your rules", rules.rules),
    ...(rules.agent ? [stepCheck("agent", `${req.agent.name}'s allowance`, rules.agent)] : []),
  ];

  // Free, deterministic prompt-injection screen of the listing (D-035): works on any model.
  const injection = detectInjection(product.description);
  if (injection.flagged) {
    rules.verdict = "BLOCK";
    rules.reasons.unshift(`Listing looks like a prompt injection: it ${injection.reasons.join(", ")}`);
  }
  checks.push({
    step: "injection",
    label: "Prompt-injection screen",
    outcome: injection.flagged ? "block" : "pass",
    detail: injection.flagged ? `Listing ${injection.reasons.join(", ")}` : "No instructions aimed at AI agents in the listing",
  });

  const base: Omit<NewTransaction, "status" | "decisionReasons" | "checks" | "riskLevel" | "riskReason"> = {
    userId,
    agentId: req.agent.id,
    agentName: req.agent.name,
    source: req.source,
    merchantId: merchant.id,
    merchantName: merchant.name,
    productId: product.id,
    title: product.name,
    quantity,
    unitPrice: product.price,
    amount,
    currency: "USD",
    userIntent: req.userIntent.slice(0, 1000),
    agentReason: req.agentReason.slice(0, 1000),
  };

  if (rules.verdict === "BLOCK") {
    checks.push(
      { step: "risk", label: "AI risk check", outcome: "skip", detail: "Not needed: already blocked" },
      { step: "decision", label: "Decision", outcome: "block", detail: "Blocked: nothing was paid" },
    );
    const tx = await insertTransaction({ ...base, status: "BLOCKED", decisionReasons: rules.reasons, checks, riskLevel: null, riskReason: null });
    await audit(userId, "PURCHASE_BLOCKED", `Blocked ${product.name} (${fmt(amount)}) from ${req.agent.name}: ${rules.reasons.join("; ")}`, tx.id);
    return result(tx);
  }

  let verdict: Verdict = rules.verdict;
  const reasons = [...rules.reasons];

  // 4. No vaulted wallet means the agent can't pay on its own: a human has to approve.
  const vaultId = await getVaultId(userId);
  if (verdict === "ALLOW" && !vaultId) {
    verdict = "NEEDS_APPROVAL";
    reasons.push("No PayPal wallet connected for auto-pay, so this needs your approval");
    checks.push({ step: "wallet", label: "Saved PayPal", outcome: "ask", detail: "No saved PayPal for auto-pay, so you approve in PayPal" });
  } else if (verdict === "ALLOW") {
    checks.push({ step: "wallet", label: "Saved PayPal", outcome: "pass", detail: "Your saved PayPal is ready for auto-pay" });
  }

  // 5. AI intent / risk check: can only make the verdict stricter. In "autopay" mode it only runs
  // when money would move without a human, saving free-tier AI quota (D-036).
  let risk: RiskAssessment | null = null;
  if (verdict === "ALLOW" || config.riskCheck() === "always") {
    risk = await assessRisk({
      userIntent: req.userIntent,
      agentReason: req.agentReason,
      title: product.name,
      description: product.description,
      category: product.category,
      merchantName: merchant.name,
      merchantVerified: merchant.verified,
      rating: product.rating,
      quantity,
      unitPrice: product.price,
      amount,
    });
    if (risk.level === "high") {
      verdict = "BLOCK";
      reasons.unshift(`AI risk check: ${risk.reason}`);
    } else {
      if (risk.level === "medium") verdict = stricter(verdict, "NEEDS_APPROVAL");
      reasons.push(`AI risk check (${risk.level}): ${risk.reason}`);
    }
    checks.push({
      step: "risk",
      label: `AI risk check: ${risk.level}`,
      outcome: risk.level === "high" ? "block" : risk.level === "medium" ? "ask" : "pass",
      detail: risk.reason,
    });
  } else {
    reasons.push("AI risk check skipped: you are reviewing this purchase yourself");
    checks.push({ step: "risk", label: "AI risk check", outcome: "skip", detail: "Skipped: you are reviewing this purchase yourself" });
  }

  // 6. Re-check the budgets and insert in one database transaction. A per-user advisory lock
  // serialises this user's purchases, so two racing through the (async) risk check can't both
  // spend the last of the budget or of the agent's allowance (LLD §5).
  const tx = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]);
    if (verdict !== "BLOCK") {
      const agentNow = (await getAgent(userId, req.agent.id, client)) ?? req.agent;
      const recheck = evaluatePolicy(policy, await spendSummary(userId, policy, client), { product, merchant, amount }, agentNow);
      if (recheck.verdict === "BLOCK") {
        verdict = "BLOCK";
        reasons.splice(0, reasons.length, ...recheck.reasons);
      }
      checks.push({
        step: "recheck",
        label: "Final budget check",
        outcome: recheck.verdict === "BLOCK" ? "block" : "pass",
        detail: recheck.verdict === "BLOCK" ? recheck.reasons.join("; ") : "Budgets re-checked at the moment of the decision (no double-spending)",
      });
    }
    checks.push({
      step: "decision",
      label: "Decision",
      outcome: verdict === "BLOCK" ? "block" : verdict === "NEEDS_APPROVAL" ? "ask" : "pass",
      detail: verdict === "BLOCK" ? "Blocked: nothing was paid" : verdict === "NEEDS_APPROVAL" ? "Waiting for your approval in PayPal" : "Approved for auto-pay",
    });
    // PROCESSING reserves the budget while the PayPal capture below is in flight.
    const status = verdict === "BLOCK" ? "BLOCKED" : verdict === "NEEDS_APPROVAL" ? "PENDING_APPROVAL" : "PROCESSING";
    return insertTransaction({ ...base, status, decisionReasons: reasons, checks, riskLevel: risk?.level ?? null, riskReason: risk?.reason ?? null }, client);
  });

  if (tx.status === "BLOCKED") {
    await audit(userId, "PURCHASE_BLOCKED", `Blocked ${product.name} (${fmt(amount)}) from ${req.agent.name}: ${reasons[0]}`, tx.id, { risk });
    return result(tx);
  }
  if (tx.status === "PENDING_APPROVAL") {
    await audit(userId, "APPROVAL_REQUESTED", `${req.agent.name} is waiting for your approval: ${product.name} (${fmt(amount)})`, tx.id, { risk });
    return result(tx);
  }

  // 7. Auto-pay with this user's vaulted PayPal wallet.
  return result(await autoPay(tx, vaultId!));
}

async function autoPay(tx: Transaction, vaultId: string): Promise<Transaction> {
  try {
    let order = await paypal.createVaultedOrder(orderInput(tx), vaultId);
    if (order.status !== "COMPLETED") {
      order = await paypal.captureOrder(order.id, `${tx.id}-vault-capture`);
    }
    const capture = paypal.firstCapture(order);
    if (order.status !== "COMPLETED" || !capture || capture.status === "DECLINED" || capture.status === "FAILED") {
      throw new Error(`PayPal returned order status ${order.status}${capture ? ` / capture ${capture.status}` : ""}`);
    }
    const paid = await updateTransaction(tx.id, { status: "PAID", paypalOrderId: order.id, paypalCaptureId: capture.id });
    await audit(tx.userId, "PAYPAL_CAPTURED", `Auto-paid ${fmt(tx.amount)} to ${tx.merchantName} for ${tx.agentName} with your saved PayPal`, tx.id, {
      orderId: order.id,
      captureId: capture.id,
      captureStatus: capture.status,
    });
    return paid;
  } catch (err) {
    return markFailed(tx, err);
  }
}

// ---------- human approval path (used by /api/approvals/*; always the logged-in owner) ----------

export async function createApprovalOrder(userId: string, txId: string, saveWallet = false): Promise<string> {
  const tx = await requireStatus(userId, txId, "PENDING_APPROVAL");
  // Only offer to save a wallet when this user has none connected yet.
  const save = saveWallet && !(await getVaultId(userId));
  const approvePage = `${config.appUrl()}/approve/${tx.id}`;
  const order = await paypal.createOrder(
    orderInput(tx),
    Date.now().toString(36),
    save ? { returnUrl: approvePage, cancelUrl: approvePage } : undefined,
  );
  await updateTransaction(tx.id, { paypalOrderId: order.id });
  await audit(
    userId,
    "PAYPAL_ORDER_CREATED",
    `PayPal order ${order.id} created for approval${save ? " (will save your PayPal for auto-pay)" : ""}`,
    tx.id,
  );
  return order.id;
}

export async function captureApprovedOrder(userId: string, txId: string, orderId: string): Promise<Transaction> {
  const tx = await requireStatus(userId, txId, "PENDING_APPROVAL");
  if (tx.paypalOrderId !== orderId) throw new PurchaseInputError("This PayPal order does not belong to this purchase.");
  try {
    const order = await paypal.captureOrder(orderId, `${tx.id}-capture-${orderId}`);
    const capture = paypal.firstCapture(order);
    if (order.status !== "COMPLETED" || !capture) throw new Error(`PayPal returned order status ${order.status}`);
    const paid = await updateTransaction(tx.id, {
      status: "PAID",
      paypalCaptureId: capture.id,
      decisionReasons: [...tx.decisionReasons, "Approved by you in PayPal"],
    });
    await audit(userId, "PAYPAL_CAPTURED", `You approved ${fmt(tx.amount)} to ${tx.merchantName}; payment captured`, tx.id, {
      orderId,
      captureId: capture.id,
      payer: order.payment_source?.paypal?.email_address,
    });
    // "Save with purchase": PayPal returns the saved wallet's vault id with the capture.
    const saved = paypal.vaultedWallet(order);
    if (saved && !(await getVaultId(userId))) {
      await setWalletConnected(userId, saved.vaultId, saved.customerId, saved.email);
      await audit(userId, "WALLET_CONNECTED", `PayPal wallet ${saved.email ?? ""} saved with this purchase: auto-pay is now on`, tx.id, {
        customerId: saved.customerId,
      });
    }
    return paid;
  } catch (err) {
    // Keep it pending if the buyer can retry (e.g. instrument declined), otherwise fail.
    if (err instanceof paypal.PayPalError && err.status === 422) {
      await audit(userId, "PAYPAL_ERROR", `Capture failed: ${err.message}. You can try again.`, tx.id, { debugId: err.debugId });
      throw err;
    }
    return markFailed(tx, err);
  }
}

export async function rejectPurchase(userId: string, txId: string): Promise<Transaction> {
  const tx = await requireStatus(userId, txId, "PENDING_APPROVAL");
  const rejected = await updateTransaction(tx.id, {
    status: "REJECTED",
    decisionReasons: [...tx.decisionReasons, "Rejected by you"],
  });
  await audit(userId, "PURCHASE_REJECTED", `You rejected ${tx.title} (${fmt(tx.amount)})`, tx.id);
  return rejected;
}

/** An agent can withdraw its OWN request while it waits for approval (never approve it). */
export async function withdrawPurchase(agent: AgentContext, txId: string): Promise<Transaction> {
  const tx = await requireStatus(agent.userId, txId, "PENDING_APPROVAL");
  if (tx.agentId !== agent.id) throw new PurchaseInputError("Purchase not found.");
  const withdrawn = await updateTransaction(tx.id, {
    status: "REJECTED",
    decisionReasons: [...tx.decisionReasons, `Withdrawn by ${agent.name} before you approved it`],
  });
  await audit(agent.userId, "PURCHASE_WITHDRAWN", `${agent.name} withdrew its request for ${tx.title} (${fmt(tx.amount)})`, tx.id);
  return withdrawn;
}

// ---------- refunds (human-only, D-014) ----------

export async function refundPurchase(userId: string, txId: string): Promise<Transaction> {
  const tx = await requireStatus(userId, txId, "PAID");
  if (!tx.paypalCaptureId) throw new PurchaseInputError("This payment has no PayPal capture to refund.");
  const refund = await paypal.refundCapture(tx.paypalCaptureId, tx.amount, tx.currency, tx.id);
  const refunded = await updateTransaction(tx.id, { status: "REFUNDED", paypalRefundId: refund.id });
  await audit(userId, "PAYPAL_REFUNDED", `Refunded ${fmt(tx.amount)} from ${tx.merchantName} (refund ${refund.status})`, tx.id, {
    refundId: refund.id,
    status: refund.status,
  });
  return refunded;
}

// ---------- helpers ----------

/** A purchase owned by this user, in the given status. Other users' purchases look "not found". */
export async function getOwnTransaction(userId: string, txId: string): Promise<Transaction> {
  const tx = await getTransaction(txId);
  if (!tx || tx.userId !== userId) throw new PurchaseInputError("Purchase not found.");
  return tx;
}

async function requireStatus(userId: string, txId: string, status: Transaction["status"]): Promise<Transaction> {
  const tx = await getOwnTransaction(userId, txId);
  if (tx.status !== status) throw new PurchaseInputError(`This purchase is ${tx.status.toLowerCase().replace("_", " ")}.`);
  return tx;
}

async function markFailed(tx: Transaction, err: unknown): Promise<Transaction> {
  const message = err instanceof Error ? err.message : String(err);
  const debugId = err instanceof paypal.PayPalError ? err.debugId : null;
  console.error(`[purchase] ${tx.id} failed`, message, debugId ?? "");
  const failed = await updateTransaction(tx.id, {
    status: "FAILED",
    decisionReasons: [...tx.decisionReasons, `PayPal error: ${message}`],
  });
  await audit(tx.userId, "PAYPAL_ERROR", `Payment failed: ${message}`, tx.id, { debugId });
  return failed;
}

function orderInput(tx: Transaction): paypal.OrderInput {
  return {
    txId: tx.id,
    title: tx.title,
    merchantName: tx.merchantName,
    productId: tx.productId,
    quantity: tx.quantity,
    unitPrice: tx.unitPrice,
    amount: tx.amount,
    currency: tx.currency,
  };
}

function result(tx: Transaction): PurchaseResult {
  return {
    status: tx.status as PurchaseResult["status"],
    transactionId: tx.id,
    title: tx.title,
    merchant: tx.merchantName,
    amount: tx.amount,
    currency: tx.currency,
    reasons: tx.decisionReasons,
    // Opening it requires logging in as the owner (D-053), so it's safe to hand to the agent.
    approvalUrl: tx.status === "PENDING_APPROVAL" ? `${config.appUrl()}/approve/${tx.id}` : undefined,
  };
}

const fmt = (n: number) => `$${n.toFixed(2)}`;

const PRICE_SOURCE: Record<NonNullable<Product["source"]>, string> = {
  demo: "price from the catalog, not from the agent",
  channel3: "live price re-checked with Channel3 just now",
  quote: "price set by the store's checkout quote",
};

function stepCheck(step: DecisionCheck["step"], label: string, r: StepResult): DecisionCheck {
  return {
    step,
    label,
    outcome: r.verdict === "BLOCK" ? "block" : r.verdict === "NEEDS_APPROVAL" ? "ask" : "pass",
    detail: r.reasons.join("; "),
  };
}
