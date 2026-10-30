"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import type { Agent, AuditEvent, SpendSummary, Transaction, User, Wallet } from "@shared/types";
import Chat from "./Chat";
import { api } from "./format";
import Header from "./Header";
import Ledger from "./Ledger";
import RulesPanel from "./RulesPanel";

type LedgerData = { transactions: Transaction[]; events: AuditEvent[]; spend: SpendSummary; wallet: Wallet; agents: Agent[] };

const POLL_MS = 3000; // live ledger by polling (D-011)

export default function Dashboard() {
  const [data, setData] = useState<LedgerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);

  const refresh = useCallback(() => {
    api<LedgerData>("/api/transactions")
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    api<{ user: User }>("/api/auth/me")
      .then((r) => setUser(r.user))
      .catch(() => window.location.replace("/login"));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="min-h-dvh">
      <Header spend={data?.spend ?? null} wallet={data?.wallet ?? null} user={user} onChange={refresh} />
      <main className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
        {error && <div className="mb-4 rounded-xl bg-bad-soft px-4 py-2.5 text-sm text-bad">{error}</div>}
        <Suspense>
          <WalletNotice />
        </Suspense>
        <div className="grid gap-5 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <Chat onActivity={refresh} />
          </div>
          <div className="flex flex-col gap-5 lg:col-span-5 lg:h-[calc(100dvh-7.5rem)] lg:min-h-[34rem]">
            <RulesPanel onChange={refresh} />
            <Ledger transactions={data?.transactions ?? []} events={data?.events ?? []} agents={data?.agents ?? []} onChange={refresh} />
          </div>
        </div>
      </main>
    </div>
  );
}

/** Result of the PayPal wallet-connect redirect (/api/wallet/return → /?wallet=...), derived from the URL. */
function WalletNotice() {
  const params = useSearchParams();
  const router = useRouter();
  const wallet = params.get("wallet");
  if (!wallet) return null;
  const ok = wallet === "connected";
  const text = ok
    ? "PayPal wallet connected. Your agent can now auto-pay within your rules."
    : wallet === "cancelled"
      ? "PayPal wallet connection was cancelled."
      : `Couldn't connect PayPal: ${params.get("reason") ?? "unknown error"}`;
  return (
    <div className={`mb-4 flex items-center justify-between rounded-xl px-4 py-2.5 text-sm ${ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>
      <span>{text}</span>
      <button onClick={() => router.replace("/")} className="text-xs opacity-70 hover:opacity-100">
        Dismiss
      </button>
    </div>
  );
}
