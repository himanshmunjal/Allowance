"use client";

import { useEffect, useState } from "react";
import type { Policy, RuleSuggestion } from "@shared/types";
import { api, money } from "./format";

type PolicyResponse = { policy: Policy; sourceText: string };

export default function RulesPanel({ onChange }: { onChange: () => void }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [text, setText] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [advice, setAdvice] = useState<RuleSuggestion[]>([]);
  const [showAdvice, setShowAdvice] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    api<PolicyResponse>("/api/policy")
      .then((r) => {
        setPolicy(r.policy);
        setText(r.sourceText);
      })
      .catch((err) => setError(err.message));
    loadAdvice();
  }, []);

  // Rule advisor (D-068). Optional: if it can't load, the panel just doesn't show it.
  function loadAdvice() {
    api<{ suggestions: RuleSuggestion[] }>("/api/policy/suggestions")
      .then((r) => setAdvice(r.suggestions))
      .catch(() => setAdvice([]));
  }

  async function applySuggestion(id: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ policy: Policy; sourceText: string }>(`/api/policy/suggestions/${encodeURIComponent(id)}/apply`, { method: "POST" });
      setPolicy(r.policy);
      setText(r.sourceText);
      loadAdvice();
      onChange();
    } catch (err) {
      setError((err as Error).message);
      loadAdvice();
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ policy: Policy; summary: string }>("/api/policy/parse", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      setPolicy(r.policy);
      setSummary(r.summary);
      setEditing(false);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Your rules</h2>
          <p className="text-xs text-muted">Written in plain English, enforced in code</p>
        </div>
        {!editing && (
          <button onClick={() => setEditing(true)} className="rounded-lg px-2.5 py-1.5 text-xs text-brand hover:bg-brand-soft">
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="mt-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            className="w-full resize-none rounded-xl border border-line bg-panel-2 p-3 text-sm outline-none focus:border-brand"
            placeholder="e.g. Spend at most $100 a week. Ask me for anything over $20. Only buy coffee from Bean & Brew."
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-xs text-muted hover:text-ink">
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={busy || text.trim().length < 3}
              className="flex items-center gap-1.5 rounded-lg bg-ai px-3 py-1.5 text-xs font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
            >
              <span>✦</span> {busy ? "Turning words into rules…" : "Update rules with AI"}
            </button>
          </div>
        </div>
      ) : (
        text && (
          <div className="mt-3 rounded-xl bg-panel-2 p-3 text-xs leading-relaxed">
            <p className={`italic ${showAll ? "" : "line-clamp-2"}`}>“{text}”</p>
            {text.length > 110 && (
              <button onClick={() => setShowAll(!showAll)} aria-expanded={showAll} className="mt-1 font-medium text-brand hover:underline">
                {showAll ? "Show less" : "Show all"}
              </button>
            )}
          </div>
        )
      )}

      {summary && (
        <p className="mt-3 flex gap-1.5 rounded-xl bg-ai-soft p-2.5 text-xs text-ai">
          <span>✦</span>
          {summary}
        </p>
      )}
      {error && <p className="mt-3 text-xs text-bad">{error}</p>}

      {advice.length > 0 && (
        <div className="mt-3 rounded-xl border border-line text-xs">
          <button onClick={() => setShowAdvice(!showAdvice)} aria-expanded={showAdvice} className="flex w-full items-center justify-between gap-3 p-3 text-left font-medium">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="text-ai">✦</span>
              {advice.length} suggested from your decisions
            </span>
            <span className="font-medium text-brand">{showAdvice ? "Hide" : "Review"}</span>
          </button>
          {showAdvice && (
            <ul className="space-y-3 border-t border-line p-3">
              {advice.map((s) => (
                <li key={s.id}>
                  <div className="flex items-start justify-between gap-3">
                    <span className="font-medium">{s.title}</span>
                    <button
                      onClick={() => applySuggestion(s.id)}
                      disabled={busy}
                      className="shrink-0 rounded-lg border border-line px-2 py-0.5 font-medium text-brand hover:bg-brand-soft disabled:opacity-50"
                    >
                      Apply
                    </button>
                  </div>
                  <p className="mt-0.5 leading-relaxed text-muted">{s.evidence}</p>
                  {s.explanation && <p className="mt-0.5 leading-relaxed text-muted">{s.explanation}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {policy && (
        <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
          <Chip label="Weekly budget" value={money(policy.weeklyBudget)} />
          <Chip label="Auto-pay up to" value={money(policy.autoApproveLimit)} tone="ok" />
          <Chip label="Max per purchase" value={money(policy.perPurchaseMax)} />
          {policy.approvalCategories.map((c) => (
            <Chip key={`a-${c}`} label="Always ask" value={c} tone="warn" />
          ))}
          {(policy.categoryAskAbove ?? []).map((t) => (
            <Chip key={`t-${t.category}`} label={`Ask for ${t.category} over`} value={money(t.amount)} tone="warn" />
          ))}
          {policy.blockedCategories.map((c) => (
            <Chip key={`b-${c}`} label="Blocked" value={c} tone="bad" />
          ))}
          <Chip
            label="Unverified sellers"
            value={policy.unverifiedMerchants}
            tone={policy.unverifiedMerchants === "block" ? "bad" : policy.unverifiedMerchants === "approve" ? "warn" : undefined}
          />
          <Chip label="Merchants" value={policy.allowedMerchants.length ? `${policy.allowedMerchants.length} allowed` : "any"} />
        </div>
      )}
    </section>
  );
}

function Chip({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "bad" }) {
  const cls = tone === "ok" ? "bg-ok-soft text-ok" : tone === "warn" ? "bg-warn-soft text-warn" : tone === "bad" ? "bg-bad-soft text-bad" : "bg-panel-2 text-ink";
  return (
    <span className={`rounded-lg px-2 py-1 ${cls}`}>
      {label}: <b className="font-semibold">{value}</b>
    </span>
  );
}
