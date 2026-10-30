"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api } from "@/app/components/format";

export default function LoginView() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only same-site paths, so ?next= can't send someone to another website.
  const next = params.get("next");
  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/auth/${mode}`, { method: "POST", body: JSON.stringify({ email, password }) });
      router.replace(target);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="grid size-10 place-items-center rounded-xl bg-brand-ink text-lg font-bold text-white">A</span>
          <div className="leading-tight">
            <div className="text-lg font-semibold">Allowance</div>
            <div className="text-xs text-muted">AI agents pay with PayPal, within your rules</div>
          </div>
        </div>

        <form onSubmit={submit} className="rounded-2xl border border-line bg-panel p-6 shadow-sm">
          <h1 className="text-base font-semibold">{mode === "login" ? "Log in" : "Create your account"}</h1>
          <p className="mt-1 text-xs text-muted">
            {mode === "login"
              ? "Your rules, agents and saved PayPal are private to your account."
              : "Each account has its own rules, agents, ledger and PayPal wallet."}
          </p>

          <label className="mt-5 block text-xs font-medium" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-xl border border-line bg-panel-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />

          <label className="mt-3 block text-xs font-medium" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={mode === "signup" ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-xl border border-line bg-panel-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          {mode === "signup" && <p className="mt-1 text-[11px] text-muted">At least 8 characters.</p>}

          {error && <p className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="mt-5 w-full rounded-xl bg-brand-ink px-3 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "One moment…" : mode === "login" ? "Log in" : "Create account"}
          </button>

          <p className="mt-4 text-center text-xs text-muted">
            {mode === "login" ? "New here? " : "Already have an account? "}
            <button
              type="button"
              onClick={() => {
                setMode(mode === "login" ? "signup" : "login");
                setError(null);
              }}
              className="font-medium text-brand hover:underline"
            >
              {mode === "login" ? "Create an account" : "Log in"}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
