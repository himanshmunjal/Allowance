"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { Agent, PurchaseResult, Transaction } from "@shared/types";
import DecisionTimeline from "@/app/components/DecisionTimeline";
import { api, money, safePath, statusMeta } from "@/app/components/format";

// Allowance Checkout (D-060): a store's "Pay with Allowance" lands here. The store already set the
// price (checkout quote); the user picks which agent is buying, and Allowance decides and pays.

type Quote = {
  product: { id: string; name: string; description: string; price: number; category: string; rating: number | null; deliveryDays: number | null };
  merchant: { name: string; verified: boolean };
  agents: Agent[];
};

export default function CheckoutView({ quoteId }: { quoteId: string }) {
  const params = useSearchParams();
  const quantity = Math.min(5, Math.max(1, Number(params.get("qty")) || 1));
  const returnTo = safePath(params.get("return"));

  const [quote, setQuote] = useState<Quote | null>(null);
  const [agentId, setAgentId] = useState<string>("");
  const [intent, setIntent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ result: PurchaseResult; transaction: Transaction } | null>(null);

  useEffect(() => {
    api<Quote>(`/api/checkout/${quoteId}`)
      .then((q) => {
        setQuote(q);
        setAgentId((q.agents.find((a) => a.kind === "external" && a.status === "active") ?? q.agents[0])?.id ?? "");
        setIntent(`Buy ${quantity > 1 ? `${quantity} × ` : ""}${q.product.name} from ${q.merchant.name}`);
      })
      .catch((err: Error) => setError(err.message));
  }, [quoteId, quantity]);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      setDone(
        await api<{ result: PurchaseResult; transaction: Transaction }>(`/api/checkout/${quoteId}`, {
          method: "POST",
          body: JSON.stringify({ agentId, quantity, intent }),
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const total = quote ? Math.round(quote.product.price * quantity * 100) / 100 : 0;
  const tx = done?.transaction;
  const meta = tx ? statusMeta[tx.status] : null;

  return (
    <div className="min-h-dvh px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-lg">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-brand-ink text-sm font-bold text-white">A</span>
            <span className="font-semibold">Allowance Checkout</span>
          </div>
          {returnTo && (
            <Link href={returnTo} className="text-xs text-muted hover:text-ink">
              Cancel and return to store
            </Link>
          )}
        </div>

        <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
          {error && !quote && <div className="p-6 text-sm text-bad">{error}</div>}
          {!quote && !error && <div className="p-8 text-center text-sm text-muted">Loading…</div>}

          {quote && (
            <>
              <div className="border-b border-line px-6 py-4">
                <div className="text-xs text-muted">
                  {quote.merchant.name} is asking for payment{quote.merchant.verified ? " · verified store" : " · unverified store"}
                </div>
                <div className="mt-1 flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">
                      {quantity > 1 ? `${quantity} × ` : ""}
                      {quote.product.name}
                    </div>
                    <div className="text-xs text-muted">{quote.product.description}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-semibold">{money(total)}</div>
                    <div className="text-[11px] text-muted">price set by the store</div>
                  </div>
                </div>
              </div>

              {!done ? (
                <div className="space-y-4 p-6">
                  <fieldset>
                    <legend className="text-xs font-medium">Which agent is buying?</legend>
                    <p className="text-[11px] text-muted">Allowance applies your rules and this agent&apos;s own allowance.</p>
                    <div className="mt-2 space-y-1.5">
                      {quote.agents.map((a) => (
                        <label
                          key={a.id}
                          className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-sm ${agentId === a.id ? "border-brand bg-brand-soft" : "border-line"}`}
                        >
                          <input type="radio" name="agent" value={a.id} checked={agentId === a.id} onChange={() => setAgentId(a.id)} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{a.name}</span>
                            <span className="block text-[11px] text-muted">
                              {[
                                a.status === "paused" && "paused",
                                a.weeklyBudget !== null && `${money(Math.max(0, a.weeklyBudget - a.spentThisWeek))} of ${money(a.weeklyBudget)} left this week`,
                                a.autoPayLimit !== null && `auto-pay ≤ ${money(a.autoPayLimit)}`,
                                a.allowedCategories.length > 0 && `only ${a.allowedCategories.join(", ")}`,
                                a.alwaysAsk && "always asks",
                              ]
                                .filter(Boolean)
                                .join(" · ") || "no extra limits: your rules apply"}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  <label className="block">
                    <span className="text-xs font-medium">What was the agent asked to buy?</span>
                    <input
                      value={intent}
                      onChange={(e) => setIntent(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-line bg-panel-2 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                    <span className="text-[11px] text-muted">The AI risk check compares the order against this.</span>
                  </label>

                  {error && <p className="rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">{error}</p>}

                  <button
                    onClick={pay}
                    disabled={busy || !agentId || intent.trim().length < 3}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-ink px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
                  >
                    {busy ? "Checking your rules…" : `Pay ${money(total)} with Allowance`}
                  </button>
                  <p className="text-center text-[11px] text-muted">Allowance checks every rule before any money moves. Payment by PayPal.</p>
                </div>
              ) : (
                <div className="p-6">
                  {meta && tx && (
                    <div className="mb-4 flex items-center justify-between">
                      <span className="text-sm font-medium">
                        {tx.status === "PAID" ? "Paid" : tx.status === "PENDING_APPROVAL" ? "Needs your approval" : tx.status === "BLOCKED" ? "Declined by your rules" : meta.label}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>{meta.label}</span>
                    </div>
                  )}
                  {tx && <DecisionTimeline tx={tx} />}
                  <div className="mt-5 flex flex-col gap-2">
                    {done.result.status === "PENDING_APPROVAL" && (
                      <Link
                        href={`/approve/${done.result.transactionId}${returnTo ? `?return=${encodeURIComponent(returnTo)}` : ""}`}
                        className="rounded-xl bg-warn px-4 py-2.5 text-center text-sm font-semibold text-white hover:opacity-90"
                      >
                        Review &amp; approve in PayPal →
                      </Link>
                    )}
                    {returnTo && (
                      <Link href={returnTo} className="rounded-xl border border-line px-4 py-2.5 text-center text-sm hover:bg-panel-2">
                        Return to {quote.merchant.name}
                      </Link>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
