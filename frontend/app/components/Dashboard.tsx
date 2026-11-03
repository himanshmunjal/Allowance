"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import type { Agent, AuditEvent, Me, SpendSummary, Transaction, User, Wallet } from "@shared/types";
import Chat from "./Chat";
import { api } from "./format";
import Header from "./Header";
import KidHome from "./KidHome";
import Landing from "./Landing";
import Ledger from "./Ledger";
import RulesPanel from "./RulesPanel";

type LedgerData = { transactions: Transaction[]; events: AuditEvent[]; spend: SpendSummary; wallet: Wallet; agents: Agent[] };

const POLL_MS = 3000; // live ledger by polling (D-011)

/** Parent → the full dashboard; child → their own home (D-061). */
export default function Dashboard() {
  const [me, setMe] = useState<Me | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);

  useEffect(() => {
    api<Me>("/api/auth/me")
      .then(setMe)
      .catch(() => setLoggedOut(true));
  }, []);

  if (loggedOut) return <Landing />;
  if (!me) return <div className="grid min-h-dvh place-items-center text-sm text-muted">Loading…</div>;
  return me.role === "child" && me.child ? <KidHome child={me.child} /> : <OwnerDashboard user={me.user} />;
}

// Only a convenience: if storage is blocked, the banner just stays visible.
const HIDE_KEY = "allowance.demoStepsHidden";
function readHidden() {
  try {
    return window.sessionStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
}
function saveHidden(hidden: boolean) {
  try {
    window.sessionStorage.setItem(HIDE_KEY, hidden ? "1" : "0");
  } catch {
    // ignore
  }
}

type DemoInfo = { demo: boolean; kidLogin?: string | null; kidPassword?: string; autoPay?: boolean };

/** For a demo account: what this is, and the shortest path through it. */
function DemoBanner() {
  const [info, setInfo] = useState<DemoInfo | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    api<DemoInfo>("/api/demo/info")
      .then((d) => {
        setInfo(d);
        setHidden(readHidden());
      })
      .catch(() => setInfo(null));
  }, []);
  if (!info?.demo) return null;
  if (hidden) {
    return (
      <button onClick={() => { setHidden(false); saveHidden(false); }} className="mb-4 rounded-lg border border-line bg-panel px-3 py-1.5 text-xs text-muted hover:text-ink">
        Show demo steps
      </button>
    );
  }

  const link = "font-medium text-brand underline underline-offset-2";
  return (
    <div className="mb-4 rounded-xl border border-line bg-panel px-4 py-3 text-sm shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">Demo account: sandbox money only, deleted after 24 hours.</p>
        <button onClick={() => { setHidden(true); saveHidden(true); }} className="shrink-0 text-xs text-muted hover:text-ink">
          Hide
        </button>
      </div>
      <ol className="mt-1.5 list-inside list-decimal space-y-0.5 text-xs leading-relaxed text-muted">
        <li>
          Ask the agent for coffee beans: {info.autoPay ? "it pays with a saved sandbox PayPal, no popup." : "you approve it in PayPal, and can save the wallet for auto-pay."}
        </li>
        <li>
          Open the pending earbuds under Purchases and pay with the PayPal button. The test buyer login is in the{" "}
          <a className={link} href="https://github.com/himanshmunjal/Allowance#try-it-as-a-judge" target="_blank" rel="noreferrer">README</a>.
        </li>
        <li>
          Fire the <Link className={link} href="/lab">Attack Lab</Link> at the pipeline, then ask the <Link className={link} href="/explorer">Spending Explorer</Link> a question.
        </li>
        {info.kidLogin && (
          <li>
            Log out and in as a child: <code className="font-mono">{info.kidLogin}</code> / <code className="font-mono">{info.kidPassword}</code>
          </li>
        )}
      </ol>
    </div>
  );
}

function OwnerDashboard({ user }: { user: User }) {
  const [data, setData] = useState<LedgerData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api<LedgerData>("/api/transactions")
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
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
        <DemoBanner />
        <Suspense>
          <WalletNotice />
        </Suspense>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          <div className="min-w-0 lg:sticky lg:top-[5.5rem] lg:col-span-7 lg:self-start">
            <Chat onActivity={refresh} />
          </div>
          <div className="flex min-w-0 flex-col gap-5 lg:col-span-5">
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
