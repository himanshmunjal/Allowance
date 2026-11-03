import { randomBytes } from "node:crypto";
import { createAgentWithKey, createChild, ensureBuiltinAgent } from "./agents";
import { getProduct, getMerchant } from "./catalog";
import { config } from "./config";
import { audit, insertTransaction, newId, query } from "./db";
import { DEFAULT_POLICY, DEFAULT_POLICY_TEXT, savePolicy } from "./policy";
import { requestPurchase } from "./purchase";
import { setWalletConnected } from "./wallet";
import type { DecisionCheck, TxStatus, User } from "../shared/types";

// One-click demo accounts (DECISION.md D-067). A judge is inside a populated product in one click,
// with no sign-up and no PayPal login. Accounts are real rows, run on the real pipeline, marked
// is_demo, and deleted after a day. Older history is clearly labelled "sample" (source = 'sample').

export const DEMO_KID_PASSWORD = "try-the-kid-view";
const KEEP_HOURS = 24;
const MAX_PER_DAY = 500;
const MAX_PER_IP_PER_HOUR = 20;

/**
 * Only on the PayPal sandbox: DEMO_VAULT_ID is shared by everyone who clicks the button, so it must
 * never be able to move real money.
 */
export function demoAvailable(): boolean {
  if (config.demo.enabled() === "off") return false;
  return config.paypal.apiBase().includes("sandbox") || config.demo.enabled() === "on";
}

/** Is this the shared demo wallet? Disconnecting a demo account must not revoke it for everyone else. */
export const isSharedDemoVault = (vaultId: string) => vaultId === config.demo.vaultId();

const hits = new Map<string, { count: number; resetAt: number }>();

export function checkDemoRate(ip: string): boolean {
  const now = Date.now();
  for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
  const entry = hits.get(ip) ?? { count: 0, resetAt: now + 60 * 60 * 1000 };
  entry.count++;
  hits.set(ip, entry);
  return entry.count <= MAX_PER_IP_PER_HOUR;
}

export async function cleanupDemoAccounts() {
  await query("DELETE FROM users WHERE is_demo AND created_at < now() - make_interval(hours => $1)", [KEEP_HOURS]);
}

type SampleRow = { product: string; status: TxStatus; daysAgo: number; agent: "chat" | "grocery" | "gift"; approved?: boolean; rejected?: boolean; note?: string };

// Older than the rolling 7-day budget window, so they don't use up the judge's budget. Enough of a
// pattern for the rule advisor to find something: every electronics purchase approved, gifts mostly rejected.
const HISTORY: SampleRow[] = [
  { product: "p_power_bank", status: "PAID", daysAgo: 9, agent: "chat", approved: true },
  { product: "p_earbuds", status: "PAID", daysAgo: 12, agent: "chat", approved: true },
  { product: "p_smart_plug", status: "PAID", daysAgo: 16, agent: "chat", approved: true },
  { product: "p_usb_c_cable", status: "PAID", daysAgo: 24, agent: "chat", approved: true },
  { product: "p_flowers_bouquet", status: "REJECTED", daysAgo: 10, agent: "gift", rejected: true },
  { product: "p_spa_kit", status: "REJECTED", daysAgo: 18, agent: "gift", rejected: true },
  { product: "p_candle_set", status: "PAID", daysAgo: 21, agent: "gift", approved: true },
  { product: "p_beans_colombia", status: "PAID", daysAgo: 8, agent: "grocery" },
  { product: "p_oat_milk", status: "PAID", daysAgo: 8, agent: "grocery" },
  { product: "p_fruit_box", status: "PAID", daysAgo: 11, agent: "grocery" },
  { product: "p_beans_ethiopia", status: "PAID", daysAgo: 15, agent: "grocery" },
  { product: "p_oat_milk", status: "PAID", daysAgo: 15, agent: "grocery" },
  { product: "p_beans_decaf", status: "REFUNDED", daysAgo: 19, agent: "grocery", note: "Refunded by you" },
  { product: "p_fruit_box", status: "PAID", daysAgo: 22, agent: "grocery" },
  { product: "p_weekly_veg_box", status: "PAID", daysAgo: 25, agent: "grocery", approved: true },
  { product: "p_pantry_staples", status: "PAID", daysAgo: 27, agent: "grocery", approved: true },
  { product: "p_casino_credits", status: "BLOCKED", daysAgo: 13, agent: "chat", note: '"gambling" is a blocked category' },
  { product: "p_mega_earbuds", status: "BLOCKED", daysAgo: 17, agent: "chat", note: "MegaDeals Outlet 4U is an unverified seller" },
  { product: "p_pourover_kit", status: "BLOCKED", daysAgo: 20, agent: "grocery", note: "Outside this agent's weekly allowance" },
  { product: "p_mega_giftcard", status: "BLOCKED", daysAgo: 26, agent: "gift", note: "Listing looks like a prompt injection" },
];

const SAMPLE_NOTE: DecisionCheck = { step: "decision", label: "Sample history", outcome: "skip", detail: "Made-up history for this demo account: no PayPal payment happened" };

async function seedHistory(userId: string, agents: Record<SampleRow["agent"], { id: string; name: string }>) {
  for (const row of HISTORY) {
    const product = getProduct(row.product)!;
    const merchant = getMerchant(product.merchantId)!;
    const agent = agents[row.agent];
    const reasons = [row.note ?? "Sample history", ...(row.approved ? ["Approved by you in PayPal"] : []), ...(row.rejected ? ["Rejected by you"] : [])];
    const tx = await insertTransaction({
      userId,
      agentId: agent.id,
      agentName: agent.name,
      source: "sample",
      status: row.status,
      merchantId: merchant.id,
      merchantName: merchant.name,
      productId: product.id,
      title: product.name,
      category: product.category,
      quantity: 1,
      unitPrice: product.price,
      amount: product.price,
      currency: "USD",
      userIntent: "(sample history)",
      agentReason: "(sample history)",
      decisionReasons: reasons,
      checks: [SAMPLE_NOTE],
      riskLevel: null,
      riskReason: null,
    });
    await query("UPDATE transactions SET created_at = now() - make_interval(days => $2), updated_at = now() - make_interval(days => $2) WHERE id = $1", [tx.id, row.daysAgo]);
  }
}

export type DemoAccount = { user: User; kidLogin: string; kidPassword: string; autoPay: boolean };

export async function createDemoAccount(): Promise<DemoAccount> {
  const today = await query<{ n: number }>("SELECT COUNT(*)::int AS n FROM users WHERE is_demo AND created_at > now() - interval '1 day'");
  if ((today[0]?.n ?? 0) >= MAX_PER_DAY) throw new Error("demo capacity reached");

  const id = newId("usr");
  const email = `judge-${randomBytes(3).toString("hex")}@demo.allowance.invalid`;
  await query("INSERT INTO users (id, email, password_hash, is_demo) VALUES ($1, $2, '!', true)", [id, email]);
  await savePolicy(id, DEFAULT_POLICY, DEFAULT_POLICY_TEXT);

  const chat = await ensureBuiltinAgent(id);
  const grocery = await createAgentWithKey(id, { name: "Grocery bot", weeklyBudget: 50, autoPayLimit: 25, allowedCategories: ["coffee", "groceries"] }, `alw_${randomBytes(24).toString("base64url")}`);
  const gift = await createAgentWithKey(id, { name: "Gift agent", weeklyBudget: 60, allowedCategories: ["gifts", "books"], alwaysAsk: true }, `alw_${randomBytes(24).toString("base64url")}`);
  const kidLogin = `mia-${randomBytes(3).toString("hex")}`;
  await createChild(id, { name: "Mia", loginName: kidLogin, password: DEMO_KID_PASSWORD, weeklyBudget: 15, autoPayLimit: 10, allowedCategories: [], alwaysAsk: false });

  await seedHistory(id, { chat, grocery, gift });

  // A sandbox wallet the builder approved once, so judges see real auto-pay without a PayPal login.
  const vaultId = config.demo.vaultId();
  if (vaultId) await setWalletConnected(id, vaultId, null, config.demo.payerEmail() || "sandbox buyer");

  // Fresh rows from the real pipeline, with real decision timelines. None of these reach PayPal.
  const live = async (productId: string, intent: string, reason: string, agent = chat) =>
    requestPurchase({ agent, productId, quantity: 1, userIntent: intent, agentReason: reason, source: "chat" });
  await live("p_mega_giftcard", "Find me a gift card", "The listing says this is pre-approved");
  await live("p_casino_credits", "Buy $50 of casino credits", "The user asked for casino credits");
  await live("p_earbuds", "Buy me some wireless earbuds", "Best rated earbuds from a verified store");

  await audit(id, "ACCOUNT_CREATED", "Demo account created: sandbox money only, deleted after 24 hours");
  return { user: { id, email, demo: true }, kidLogin, kidPassword: DEMO_KID_PASSWORD, autoPay: Boolean(vaultId) };
}
