import { randomBytes } from "node:crypto";
import { createAgentWithKey, createChild, ensureBuiltinAgent } from "./agents";
import { config } from "./config";
import { audit, newId, query } from "./db";
import { DEFAULT_POLICY, DEFAULT_POLICY_TEXT, savePolicy } from "./policy";
import { setWalletConnected } from "./wallet";
import type { User } from "../shared/types";

// One-click demo accounts (DECISION.md D-067). A judge is inside the product in one click, with no
// sign-up and no PayPal login. Accounts are real rows, marked is_demo, and deleted after a day.
// Each one starts fresh: agents and a kid are set up, but there are no purchases (D-076).

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

export type DemoAccount = { user: User; kidLogin: string; kidPassword: string; autoPay: boolean };

export async function createDemoAccount(): Promise<DemoAccount> {
  const today = await query<{ n: number }>("SELECT COUNT(*)::int AS n FROM users WHERE is_demo AND created_at > now() - interval '1 day'");
  if ((today[0]?.n ?? 0) >= MAX_PER_DAY) throw new Error("demo capacity reached");

  const id = newId("usr");
  const email = `judge-${randomBytes(3).toString("hex")}@demo.allowance.invalid`;
  await query("INSERT INTO users (id, email, password_hash, is_demo) VALUES ($1, $2, '!', true)", [id, email]);
  await savePolicy(id, DEFAULT_POLICY, DEFAULT_POLICY_TEXT);

  await ensureBuiltinAgent(id);
  await createAgentWithKey(id, { name: "Grocery bot", weeklyBudget: 50, autoPayLimit: 25, allowedCategories: ["coffee", "groceries"] }, `alw_${randomBytes(24).toString("base64url")}`);
  await createAgentWithKey(id, { name: "Gift agent", weeklyBudget: 60, allowedCategories: ["gifts", "books"], alwaysAsk: true }, `alw_${randomBytes(24).toString("base64url")}`);
  const kidLogin = `mia-${randomBytes(3).toString("hex")}`;
  await createChild(id, { name: "Mia", loginName: kidLogin, password: DEMO_KID_PASSWORD, weeklyBudget: 15, autoPayLimit: 10, allowedCategories: [], alwaysAsk: false });

  // A sandbox wallet the builder approved once, so judges see real auto-pay without a PayPal login.
  const vaultId = config.demo.vaultId();
  if (vaultId) await setWalletConnected(id, vaultId, null, config.demo.payerEmail() || "sandbox buyer");

  await audit(id, "ACCOUNT_CREATED", "Demo account created: sandbox money only, deleted after 24 hours");
  return { user: { id, email, demo: true }, kidLogin, kidPassword: DEMO_KID_PASSWORD, autoPay: Boolean(vaultId) };
}
