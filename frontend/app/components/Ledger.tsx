"use client";

import Link from "next/link";
import { useState } from "react";
import type { Agent, AuditEvent, Transaction } from "@shared/types";
import AgentsPanel from "./AgentsPanel";
import { api, money, statusMeta, timeAgo } from "./format";

export default function Ledger({
  transactions,
  events,
  agents,
  onChange,
}: {
  transactions: Transaction[];
  events: AuditEvent[];
  agents: Agent[];
  onChange: () => void;
}) {
  const [tab, setTab] = useState<"ledger" | "agents" | "audit">("ledger");
  const label = { ledger: `Purchases (${transactions.length})`, agents: `Agents (${agents.length})`, audit: "Audit trail" };

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
      <div className="flex items-center justify-between border-b border-line px-5 pt-3">
        <div className="flex gap-4 text-sm">
          {(["ledger", "agents", "audit"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 pb-2.5 ${tab === t ? "border-brand font-semibold text-ink" : "border-transparent text-muted hover:text-ink"}`}
            >
              {label[t]}
            </button>
          ))}
        </div>
        <span className="flex items-center gap-1.5 pb-2.5 text-[11px] text-muted">
          <span className="size-1.5 animate-pulse rounded-full bg-ok" /> live
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "ledger" ? (
          <Purchases transactions={transactions} onChange={onChange} />
        ) : tab === "agents" ? (
          <AgentsPanel agents={agents} onChange={onChange} />
        ) : (
          <Audit events={events} />
        )}
      </div>
    </section>
  );
}

function Purchases({ transactions, onChange }: { transactions: Transaction[]; onChange: () => void }) {
  if (!transactions.length) {
    return <p className="p-6 text-center text-sm text-muted">No purchases yet. Ask the agent to buy something.</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {transactions.map((t) => (
        <Row key={t.id} tx={t} onChange={onChange} />
      ))}
    </ul>
  );
}

function Row({ tx, onChange }: { tx: Transaction; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = statusMeta[tx.status];
  const struck = tx.status === "BLOCKED" || tx.status === "REJECTED" || tx.status === "REFUNDED" || tx.status === "FAILED";

  async function refund() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/transactions/${tx.id}/refund`, { method: "POST" });
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="px-5 py-3">
      <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 text-left">
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${meta.dot}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {tx.quantity > 1 ? `${tx.quantity} × ` : ""}
            {tx.title}
          </span>
          <span className="block text-xs text-muted">
            {tx.merchantName} · {timeAgo(tx.createdAt)} · {tx.agentName ?? (tx.source === "mcp" ? "external agent (MCP)" : "chat agent")}
          </span>
        </span>
        <span className="text-right">
          <span className={`block text-sm font-semibold ${struck ? "text-muted line-through" : ""}`}>{money(tx.amount)}</span>
          <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.className}`}>{meta.label}</span>
        </span>
      </button>

      {open && (
        <div className="mt-2.5 space-y-2 rounded-xl bg-panel-2 p-3 text-xs">
          <Field label="You asked">{tx.userIntent}</Field>
          <Field label="Agent's reason">{tx.agentReason}</Field>
          <div>
            <div className="mb-0.5 text-muted">Decision</div>
            <ul className="space-y-0.5">
              {tx.decisionReasons.map((r, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className={r.startsWith("AI risk") ? "text-ai" : "text-muted"}>{r.startsWith("AI risk") ? "✦" : "•"}</span>
                  {r}
                </li>
              ))}
            </ul>
          </div>
          {(tx.paypalOrderId || tx.paypalCaptureId) && (
            <div className="font-mono text-[10px] text-muted">
              {tx.paypalOrderId && <div>PayPal order {tx.paypalOrderId}</div>}
              {tx.paypalCaptureId && <div>capture {tx.paypalCaptureId}</div>}
              {tx.paypalRefundId && <div>refund {tx.paypalRefundId}</div>}
            </div>
          )}
        </div>
      )}

      {(tx.status === "PAID" || tx.status === "PENDING_APPROVAL") && (
        <div className="mt-2 flex items-center justify-end gap-2">
          {error && <span className="mr-auto text-[11px] text-bad">{error}</span>}
          {tx.status === "PAID" && tx.paypalCaptureId && (
            <button
              onClick={refund}
              disabled={busy}
              className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted hover:border-bad hover:text-bad disabled:opacity-50"
            >
              {busy ? "Refunding…" : "↩ Refund"}
            </button>
          )}
          {tx.status === "PENDING_APPROVAL" && (
            <Link href={`/approve/${tx.id}`} className="rounded-lg bg-warn px-2.5 py-1 text-xs font-medium text-white hover:opacity-90">
              Review &amp; approve →
            </Link>
          )}
        </div>
      )}
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div>{children}</div>
    </div>
  );
}

const eventIcon: Record<string, string> = {
  PAYPAL_CAPTURED: "💸",
  PAYPAL_REFUNDED: "↩️",
  PAYPAL_ORDER_CREATED: "🧾",
  PAYPAL_ERROR: "⚠️",
  PURCHASE_BLOCKED: "⛔",
  PURCHASE_REJECTED: "✋",
  APPROVAL_REQUESTED: "⏳",
  POLICY_UPDATED: "📜",
  WALLET_CONNECTED: "🔐",
  WALLET_CONNECT_STARTED: "🔐",
  WALLET_DISCONNECTED: "🔓",
  WEBHOOK: "📡",
  ACCOUNT_CREATED: "👤",
  AGENT_CREATED: "🤖",
  AGENT_UPDATED: "🤖",
  AGENT_REVOKED: "🚫",
  PURCHASE_WITHDRAWN: "↩️",
};

function Audit({ events }: { events: AuditEvent[] }) {
  if (!events.length) return <p className="p-6 text-center text-sm text-muted">Nothing has happened yet.</p>;
  return (
    <ol className="space-y-0.5 p-3">
      {events.map((e) => (
        <li key={e.id} className="flex gap-2.5 rounded-lg px-2 py-1.5 text-xs hover:bg-panel-2">
          <span className="w-5 shrink-0 text-center">{eventIcon[e.type] ?? "•"}</span>
          <span className="flex-1">
            {e.message}
            <span className="block font-mono text-[10px] text-muted">
              {e.type} · {timeAgo(e.createdAt)}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}
