import pg from "pg";
import { randomBytes } from "node:crypto";
import { config } from "./config";
import type { AuditEvent, Transaction } from "../shared/types";

// PostgreSQL (DECISION.md D-055). One pool per process, stored on globalThis so dev hot-reload
// doesn't open a new pool per edit. Money is NUMERIC(12,2) and timestamps are TIMESTAMPTZ; the
// type parsers below hand them to the app as numbers and ISO strings.

pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v) => new Date(v).toISOString());
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

/** The pool, or a client inside a transaction: both can run queries. */
export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

const globalForDb = globalThis as unknown as { allowancePool?: pg.Pool; allowanceMigrated?: Promise<void> };

function pool(): pg.Pool {
  globalForDb.allowancePool ??= new pg.Pool({ connectionString: config.databaseUrl(), max: 10 });
  return globalForDb.allowancePool;
}

/** Runs the migrations once per process; every query waits for it. */
function ready(): Promise<void> {
  globalForDb.allowanceMigrated ??= migrate(pool()).catch((err) => {
    globalForDb.allowanceMigrated = undefined; // retry on the next query (e.g. Postgres was down)
    throw err;
  });
  return globalForDb.allowanceMigrated;
}

export async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = [], on?: Queryable): Promise<T[]> {
  await ready();
  return (await (on ?? pool()).query<T>(sql, params)).rows;
}

export async function queryOne<T extends pg.QueryResultRow>(sql: string, params: unknown[] = [], on?: Queryable): Promise<T | null> {
  return (await query<T>(sql, params, on))[0] ?? null;
}

/** Run fn in one database transaction (COMMIT on success, ROLLBACK on error). */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  await ready();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Startup check used by server.ts: connects and migrates, so a bad DATABASE_URL fails loudly. */
export const ensureDatabase = ready;

async function migrate(p: pg.Pool) {
  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    -- One row per user (D-053).
    CREATE TABLE IF NOT EXISTS policies (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      policy JSONB NOT NULL,
      source_text TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wallets (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      setup_token_id TEXT,
      payment_token_id TEXT,
      customer_id TEXT,
      payer_email TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Per-agent allowances (D-054). NULL limit = only the user's own rules apply.
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      key_hash TEXT UNIQUE,
      key_hint TEXT,
      weekly_budget NUMERIC(12,2),
      auto_pay_limit NUMERIC(12,2),
      allowed_categories JSONB NOT NULL DEFAULT '[]',
      always_ask BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id TEXT,
      agent_name TEXT,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      merchant_id TEXT NOT NULL,
      merchant_name TEXT NOT NULL,
      product_id TEXT NOT NULL,
      title TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price NUMERIC(12,2) NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      currency TEXT NOT NULL,
      user_intent TEXT NOT NULL,
      agent_reason TEXT NOT NULL,
      decision_reasons JSONB NOT NULL,
      risk_level TEXT,
      risk_reason TEXT,
      paypal_order_id TEXT,
      paypal_capture_id TEXT,
      paypal_refund_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tx_agent ON transactions(agent_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tx_order ON transactions(paypal_order_id);
    CREATE INDEX IF NOT EXISTS idx_tx_capture ON transactions(paypal_capture_id);
    CREATE TABLE IF NOT EXISTS audit_events (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      tx_id TEXT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      data JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_events(user_id, id);
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      messages JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY,
      quote JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export const now = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;
/** JSONB parameters must be sent as JSON text (pg would turn a JS array into a Postgres array). */
export const jsonb = (v: unknown) => JSON.stringify(v);

// ---------- transactions ----------

type TxRow = {
  id: string;
  user_id: string;
  agent_id: string | null;
  agent_name: string | null;
  source: string;
  status: string;
  merchant_id: string;
  merchant_name: string;
  product_id: string;
  title: string;
  quantity: number;
  unit_price: number;
  amount: number;
  currency: string;
  user_intent: string;
  agent_reason: string;
  decision_reasons: string[];
  risk_level: string | null;
  risk_reason: string | null;
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
  paypal_refund_id: string | null;
  created_at: string;
  updated_at: string;
};

function toTransaction(r: TxRow): Transaction {
  return {
    id: r.id,
    userId: r.user_id,
    agentId: r.agent_id,
    agentName: r.agent_name,
    source: r.source as Transaction["source"],
    status: r.status as Transaction["status"],
    merchantId: r.merchant_id,
    merchantName: r.merchant_name,
    productId: r.product_id,
    title: r.title,
    quantity: r.quantity,
    unitPrice: r.unit_price,
    amount: r.amount,
    currency: r.currency,
    userIntent: r.user_intent,
    agentReason: r.agent_reason,
    decisionReasons: r.decision_reasons,
    riskLevel: r.risk_level as Transaction["riskLevel"],
    riskReason: r.risk_reason,
    paypalOrderId: r.paypal_order_id,
    paypalCaptureId: r.paypal_capture_id,
    paypalRefundId: r.paypal_refund_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export type NewTransaction = Omit<
  Transaction,
  "id" | "createdAt" | "updatedAt" | "paypalOrderId" | "paypalCaptureId" | "paypalRefundId"
>;

export async function insertTransaction(tx: NewTransaction, on?: Queryable): Promise<Transaction> {
  const row = await queryOne<TxRow>(
    `INSERT INTO transactions (id, user_id, agent_id, agent_name, source, status, merchant_id, merchant_name, product_id,
       title, quantity, unit_price, amount, currency, user_intent, agent_reason, decision_reasons, risk_level, risk_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     RETURNING *`,
    [
      newId("tx"), tx.userId, tx.agentId, tx.agentName, tx.source, tx.status, tx.merchantId, tx.merchantName, tx.productId,
      tx.title, tx.quantity, tx.unitPrice, tx.amount, tx.currency, tx.userIntent, tx.agentReason, jsonb(tx.decisionReasons),
      tx.riskLevel, tx.riskReason,
    ],
    on,
  );
  return toTransaction(row!);
}

const updatableColumns = {
  status: "status",
  decisionReasons: "decision_reasons",
  paypalOrderId: "paypal_order_id",
  paypalCaptureId: "paypal_capture_id",
  paypalRefundId: "paypal_refund_id",
} as const;

export type TxUpdate = Partial<Pick<Transaction, keyof typeof updatableColumns>>;

export async function updateTransaction(id: string, patch: TxUpdate): Promise<Transaction> {
  const sets = ["updated_at = now()"];
  const params: unknown[] = [id];
  for (const [key, column] of Object.entries(updatableColumns)) {
    const value = patch[key as keyof TxUpdate];
    if (value !== undefined) {
      params.push(key === "decisionReasons" ? jsonb(value) : value);
      sets.push(`${column} = $${params.length}`);
    }
  }
  const row = await queryOne<TxRow>(`UPDATE transactions SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
  return toTransaction(row!);
}

export async function getTransaction(id: string): Promise<Transaction | null> {
  const row = await queryOne<TxRow>("SELECT * FROM transactions WHERE id = $1", [id]);
  return row ? toTransaction(row) : null;
}

export async function findTransactionBy(column: "paypal_order_id" | "paypal_capture_id", value: string) {
  const row = await queryOne<TxRow>(`SELECT * FROM transactions WHERE ${column} = $1`, [value]);
  return row ? toTransaction(row) : null;
}

/** A user's purchases, newest first; optionally only one agent's. */
export async function listTransactions(userId: string, limit = 50, agentId?: string): Promise<Transaction[]> {
  const rows = agentId
    ? await query<TxRow>("SELECT * FROM transactions WHERE user_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT $3", [userId, agentId, limit])
    : await query<TxRow>("SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2", [userId, limit]);
  return rows.map(toTransaction);
}

// ---------- audit log (append-only) ----------

/** userId null = a system event not tied to an account (e.g. an unmatched webhook). */
export async function audit(userId: string | null, type: string, message: string, txId: string | null = null, data?: unknown) {
  await query("INSERT INTO audit_events (user_id, tx_id, type, message, data) VALUES ($1, $2, $3, $4, $5)", [
    userId,
    txId,
    type,
    message,
    data === undefined ? null : jsonb(data),
  ]);
}

export async function listAuditEvents(userId: string, limit = 100): Promise<AuditEvent[]> {
  const rows = await query<{ id: number; tx_id: string | null; type: string; message: string; data: unknown; created_at: string }>(
    "SELECT * FROM audit_events WHERE user_id = $1 ORDER BY id DESC LIMIT $2",
    [userId, limit],
  );
  return rows.map((r) => ({ id: r.id, txId: r.tx_id, type: r.type, message: r.message, data: r.data, createdAt: r.created_at }));
}
