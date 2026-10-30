"use client";

import { useState } from "react";
import type { SpendSummary, User, Wallet } from "@shared/types";
import { api, ApiError, money } from "./format";

export default function Header({
  spend,
  wallet,
  user,
  onChange,
}: {
  spend: SpendSummary | null;
  wallet: Wallet | null;
  user: User | null;
  onChange: () => void;
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-panel/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-xl bg-brand-ink text-lg font-bold text-white">A</span>
          <div className="leading-tight">
            <div className="font-semibold">Allowance</div>
            <div className="text-xs text-muted">AI agents pay with PayPal, within your rules</div>
          </div>
        </div>
        <div className="order-3 w-full sm:order-none sm:w-auto sm:flex-1">{spend && <BudgetMeter spend={spend} />}</div>
        <WalletButton wallet={wallet} onChange={onChange} />
        {user && <AccountMenu user={user} />}
      </div>
    </header>
  );
}

function AccountMenu({ user }: { user: User }) {
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.replace("/login");
  }
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="hidden max-w-40 truncate text-muted lg:inline" title={user.email}>
        {user.email}
      </span>
      <button onClick={logout} disabled={busy} className="rounded-lg border border-line px-2.5 py-1.5 text-muted hover:text-ink disabled:opacity-50">
        Log out
      </button>
    </div>
  );
}

function BudgetMeter({ spend }: { spend: SpendSummary }) {
  const pct = (n: number) => `${spend.weeklyBudget > 0 ? Math.min(100, (n / spend.weeklyBudget) * 100) : 0}%`;
  return (
    <div className="mx-auto max-w-md">
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-muted">This week</span>
        <span>
          <b>{money(spend.remaining)}</b> <span className="text-muted">left of {money(spend.weeklyBudget)}</span>
        </span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-panel-2 ring-1 ring-line">
        <div className="bg-brand transition-all" style={{ width: pct(spend.spent) }} title={`Spent ${money(spend.spent)}`} />
        <div className="bg-warn/70 transition-all" style={{ width: pct(spend.pending) }} title={`Awaiting approval ${money(spend.pending)}`} />
      </div>
      <div className="mt-1 flex gap-3 text-[11px] text-muted">
        <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-brand" /> spent {money(spend.spent)}</span>
        <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-warn/70" /> awaiting approval {money(spend.pending)}</span>
      </div>
    </div>
  );
}

function WalletButton({ wallet, onChange }: { wallet: Wallet | null; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; hint: boolean } | null>(null);

  async function connect() {
    setBusy(true);
    setMessage(null);
    try {
      const { approveUrl } = await api<{ approveUrl: string }>("/api/wallet/connect", { method: "POST" });
      window.location.href = approveUrl;
    } catch (err) {
      // 409 = use "save with purchase" on the approval page instead: a hint, not an error (D-046).
      setMessage({ text: (err as Error).message, hint: err instanceof ApiError && err.status === 409 });
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api("/api/wallet", { method: "DELETE" });
      onChange();
    } finally {
      setBusy(false);
    }
  }

  if (wallet?.status === "CONNECTED") {
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 rounded-xl bg-ok-soft px-3 py-2 text-xs text-ok">
          <span className="size-2 rounded-full bg-ok" />
          <span>
            <b>Auto-pay on</b>
            {wallet.payerEmail ? <span className="hidden opacity-80 md:inline"> · {wallet.payerEmail}</span> : null}
          </span>
        </div>
        <button onClick={disconnect} disabled={busy} className="text-xs text-muted hover:text-bad">
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end">
      <button
        onClick={connect}
        disabled={busy}
        className="flex items-center gap-2 rounded-xl bg-[#ffc439] px-3.5 py-2 text-xs font-semibold text-[#003087] hover:brightness-95 disabled:opacity-60"
        title="Save your PayPal wallet (Vault) so the agent can pay small purchases without a popup"
      >
        {busy ? "Opening PayPal…" : "Connect PayPal for auto-pay"}
      </button>
      {message && (
        <span className={`mt-1 max-w-64 text-right text-[11px] ${message.hint ? "text-warn" : "text-bad"}`}>
          {message.hint ? "💡 " : ""}
          {message.text}
        </span>
      )}
    </div>
  );
}
