"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Agent, Transaction } from "@shared/types";
import Chat from "./Chat";
import { api, money, timeAgo } from "./format";
import { AccountMenu } from "./Header";

// A child's home (D-061): their allowance, a shopping helper that spends from it, and their own
// requests. No rules, wallet, approvals or refunds here: those are the parent's.

const POLL_MS = 3000;

const KID_STATUS: Record<Transaction["status"], { label: string; className: string }> = {
  PAID: { label: "Bought 🎉", className: "bg-ok-soft text-ok" },
  PROCESSING: { label: "Paying…", className: "bg-brand-soft text-brand" },
  PENDING_APPROVAL: { label: "Waiting for your parent", className: "bg-warn-soft text-warn" },
  BLOCKED: { label: "Not allowed", className: "bg-bad-soft text-bad" },
  REJECTED: { label: "Not this time", className: "bg-panel-2 text-muted" },
  REFUNDED: { label: "Refunded", className: "bg-panel-2 text-muted" },
  FAILED: { label: "Didn't go through", className: "bg-bad-soft text-bad" },
};

export default function KidHome({ child: initial }: { child: Agent }) {
  const [child, setChild] = useState<Agent>(initial);
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  const refresh = useCallback(() => {
    api<{ child: Agent; transactions: Transaction[] }>("/api/kid")
      .then((d) => {
        setChild(d.child);
        setTransactions(d.transactions);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const budget = child.weeklyBudget ?? 0;
  const left = Math.max(0, budget - child.spentThisWeek);
  const pct = budget > 0 ? Math.min(100, (child.spentThisWeek / budget) * 100) : 100;

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-line bg-panel/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-xl bg-brand-ink text-lg font-bold text-on-accent">A</span>
            <div className="leading-tight">
              <div className="font-semibold">Hi, {child.name}!</div>
              <div className="text-xs text-muted">Your Allowance, set up by your parent</div>
            </div>
          </div>
          <div className="order-3 w-full sm:order-none sm:w-auto sm:flex-1">
            <div className="mx-auto max-w-md">
              <div className="mb-1 flex justify-between text-xs">
                <span className="text-muted">My allowance this week</span>
                <span>
                  <b>{money(left)}</b> <span className="text-muted">left of {money(budget)}</span>
                </span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-panel-2 ring-1 ring-line">
                <div className={`h-full transition-all ${pct >= 100 ? "bg-bad" : "bg-brand"}`} style={{ width: `${pct}%` }} />
              </div>
            </div>
          </div>
          <Link href="/store" className="rounded-lg px-2.5 py-1.5 text-xs text-muted hover:bg-panel-2 hover:text-ink">
            🛍 Demo store
          </Link>
          <AccountMenu label={`Logged in as ${child.loginName ?? child.name}`} />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
        {child.status === "paused" && (
          <div className="mb-4 rounded-xl bg-warn-soft px-4 py-2.5 text-sm text-warn">
            Your parent paused your allowance for now, so nothing can be bought. Ask them if you need something.
          </div>
        )}
        <div className="grid gap-5 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <Chat onActivity={refresh} kid={child.name} />
          </div>
          <div className="flex flex-col gap-5 lg:col-span-5">
            <MyRules child={child} />
            <MyRequests transactions={transactions} onChange={refresh} />
          </div>
        </div>
      </main>
    </div>
  );
}

function MyRules({ child }: { child: Agent }) {
  const rules = [
    `Up to ${money(child.weeklyBudget ?? 0)} a week`,
    child.alwaysAsk ? "Your parent says yes to everything first" : child.autoPayLimit !== null ? `Things up to ${money(child.autoPayLimit)} are bought straight away; bigger ones need a yes from your parent` : null,
    child.allowedCategories.length ? `You can buy: ${child.allowedCategories.join(", ")}` : null,
    "Never allowed: alcohol, vaping, gambling, weapons or adult things",
  ].filter(Boolean);
  return (
    <section className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
      <h2 className="text-sm font-semibold">My rules</h2>
      <ul className="mt-2 space-y-1 text-xs text-muted">
        {rules.map((r) => (
          <li key={r} className="flex gap-1.5">
            <span>•</span>
            <span>{r}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MyRequests({ transactions, onChange }: { transactions: Transaction[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  async function cancel(id: string) {
    setBusy(id);
    try {
      await api(`/api/kid/purchases/${id}/withdraw`, { method: "POST" });
      onChange();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
      <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">My purchases ({transactions.length})</h2>
      <div className="flex-1 divide-y divide-line overflow-y-auto">
        {transactions.length === 0 && <p className="p-4 text-xs text-muted">Nothing yet. Ask your shopping helper for something!</p>}
        {transactions.map((t) => {
          const s = KID_STATUS[t.status];
          // The first reason is the one that decided it (e.g. over the allowance, not allowed for kids).
          const why = t.status === "BLOCKED" || t.status === "PENDING_APPROVAL" ? t.decisionReasons[0] : null;
          return (
            <div key={t.id} className="px-4 py-3 text-xs">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{t.title}</div>
                  <div className="text-muted">
                    {t.merchantName} · {timeAgo(t.createdAt)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold">{money(t.amount)}</div>
                  <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${s.className}`}>{s.label}</span>
                </div>
              </div>
              {why && <p className="mt-1.5 text-muted">{why}</p>}
              {t.status === "PENDING_APPROVAL" && (
                <button onClick={() => cancel(t.id)} disabled={busy === t.id} className="mt-1.5 text-muted hover:text-bad disabled:opacity-50">
                  {busy === t.id ? "Cancelling…" : "Cancel this request"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
