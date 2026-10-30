import { query, queryOne } from "./db";
import type { Wallet, WalletStatus } from "../shared/types";

// Each user's saved PayPal wallet (Vault payment token) that their agents may charge (D-053).
// Every account links its own PayPal; one user's agents can never charge another user's wallet.

type WalletRow = {
  status: WalletStatus;
  setup_token_id: string | null;
  payment_token_id: string | null;
  customer_id: string | null;
  payer_email: string | null;
};

const row = (userId: string) => queryOne<WalletRow>("SELECT * FROM wallets WHERE user_id = $1", [userId]);

/** Public view: never exposes the vault id to the browser or the agent. */
export async function getWallet(userId: string): Promise<Wallet> {
  const r = await row(userId);
  return { status: r?.status ?? "DISCONNECTED", payerEmail: r?.payer_email ?? null };
}

export async function getVaultId(userId: string): Promise<string | null> {
  const r = await row(userId);
  return r?.status === "CONNECTED" ? r.payment_token_id : null;
}

export async function getPendingSetupToken(userId: string): Promise<string | null> {
  const r = await row(userId);
  return r?.status === "PENDING" ? r.setup_token_id : null;
}

async function upsert(userId: string, fields: Partial<WalletRow> & { status: WalletStatus }) {
  const f = { setup_token_id: null, payment_token_id: null, customer_id: null, payer_email: null, ...fields };
  await query(
    `INSERT INTO wallets (user_id, status, setup_token_id, payment_token_id, customer_id, payer_email)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET status = excluded.status, setup_token_id = excluded.setup_token_id,
       payment_token_id = excluded.payment_token_id, customer_id = excluded.customer_id,
       payer_email = excluded.payer_email, updated_at = now()`,
    [userId, f.status, f.setup_token_id, f.payment_token_id, f.customer_id, f.payer_email],
  );
}

export const setWalletPending = (userId: string, setupTokenId: string) => upsert(userId, { status: "PENDING", setup_token_id: setupTokenId });

export const setWalletConnected = (userId: string, paymentTokenId: string, customerId: string | null, payerEmail: string | null) =>
  upsert(userId, { status: "CONNECTED", payment_token_id: paymentTokenId, customer_id: customerId, payer_email: payerEmail });

export const setWalletDisconnected = (userId: string) => upsert(userId, { status: "DISCONNECTED" });
