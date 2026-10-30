"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PayPalOneTimePaymentButton, PayPalProvider } from "@paypal/react-paypal-js/sdk-v6";
import { api, money, statusMeta } from "@/app/components/format";
import type { Transaction, Wallet } from "@shared/types";

type Detail = {
  transaction: Transaction;
  product: { emoji: string; description: string; rating: number | null; deliveryDays: number | null; url: string | null; imageUrl: string | null } | null;
};

const CLIENT_ID = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? "";

export default function ApproveView({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  // "Save with purchase": approving this payment can also save the PayPal wallet for auto-pay.
  const [saveWallet, setSaveWallet] = useState(true);

  const load = useCallback(
    () =>
      api<Detail>(`/api/approvals/${id}`)
        .then(setDetail)
        .catch((err: Error) => setError(err.message)),
    [id],
  );

  useEffect(() => {
    api<Wallet>("/api/wallet")
      .then(setWallet)
      .catch(() => setWallet(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function reject() {
    setBusy(true);
    try {
      await api(`/api/approvals/${id}/reject`, { method: "POST" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const tx = detail?.transaction;
  const meta = tx ? statusMeta[tx.status] : null;

  return (
    <div className="min-h-dvh px-4 py-8 sm:py-14">
      <div className="mx-auto max-w-lg">
        <Link href="/" className="text-sm text-muted hover:text-ink">
          ← Back to dashboard
        </Link>

        <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
          <div className="border-b border-line bg-warn-soft px-6 py-4">
            <div className="text-xs font-medium uppercase tracking-wide text-warn">Your agent is asking permission</div>
            <div className="mt-0.5 text-sm text-ink">Review this purchase. Nothing is charged unless you approve it in PayPal.</div>
          </div>

          {!tx && !error && <div className="p-8 text-center text-sm text-muted">Loading…</div>}
          {error && <div className="p-6 text-sm text-bad">{error}</div>}

          {tx && meta && (
            <div className="p-6">
              <div className="flex items-start gap-4">
                <div className="grid size-14 shrink-0 place-items-center rounded-2xl bg-panel-2 text-3xl">{detail?.product?.emoji ?? "🛍️"}</div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">
                    {tx.quantity > 1 ? `${tx.quantity} × ` : ""}
                    {tx.title}
                  </div>
                  <div className="text-sm text-muted">{tx.merchantName}</div>
                  {detail?.product && (
                    <div className="mt-0.5 text-xs text-muted">
                      {[
                        detail.product.rating !== null && `★ ${detail.product.rating}`,
                        detail.product.deliveryDays !== null &&
                          `arrives in ${detail.product.deliveryDays} day${detail.product.deliveryDays === 1 ? "" : "s"}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      {detail.product.url && (
                        <>
                          {detail.product.rating !== null || detail.product.deliveryDays !== null ? " · " : ""}
                          <a href={detail.product.url} target="_blank" rel="noreferrer" className="underline">
                            view listing
                          </a>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-xl font-semibold">{money(tx.amount)}</div>
                  <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>{meta.label}</span>
                </div>
              </div>

              <dl className="mt-5 space-y-3 text-sm">
                <div>
                  <dt className="text-xs text-muted">You asked</dt>
                  <dd>“{tx.userIntent}”</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Why the agent picked this</dt>
                  <dd>{tx.agentReason}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Why it needs you</dt>
                  <dd>
                    <ul className="mt-1 space-y-1">
                      {tx.decisionReasons.map((r, i) => (
                        <li key={i} className="flex gap-1.5 text-[13px]">
                          <span className={r.startsWith("AI risk") ? "text-ai" : "text-muted"}>{r.startsWith("AI risk") ? "✦" : "•"}</span>
                          {r}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              </dl>

              {tx.status === "PENDING_APPROVAL" ? (
                <div className="mt-6">
                  {wallet && wallet.status !== "CONNECTED" && (
                    <label className="mb-4 flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-panel-2 p-3 text-sm">
                      <input
                        type="checkbox"
                        checked={saveWallet}
                        onChange={(e) => setSaveWallet(e.target.checked)}
                        className="mt-0.5 size-4 accent-[var(--brand)]"
                      />
                      <span>
                        <b>Save my PayPal for auto-pay</b>
                        <span className="block text-xs text-muted">
                          Your agent can then pay small purchases within your rules without asking. Everything else still comes to you.
                        </span>
                      </span>
                    </label>
                  )}
                  {CLIENT_ID ? (
                    <PayPalProvider clientId={CLIENT_ID} environment="sandbox" components={["paypal-payments"]} pageType="checkout">
                      <PayPalOneTimePaymentButton
                        disabled={busy}
                        createOrder={async () => {
                          setError(null);
                          const { orderId } = await api<{ orderId: string }>(`/api/approvals/${id}/order`, {
                            method: "POST",
                            body: JSON.stringify({ saveWallet: wallet?.status !== "CONNECTED" && saveWallet }),
                          });
                          return { orderId };
                        }}
                        onApprove={async ({ orderId }) => {
                          await api(`/api/approvals/${id}/capture`, { method: "POST", body: JSON.stringify({ orderId }) });
                          await load();
                        }}
                        onCancel={() => setError("PayPal window closed. Nothing was charged.")}
                        onError={(err) => {
                          console.error(err);
                          setError("PayPal reported an error. Nothing was charged; please try again.");
                          load();
                        }}
                      />
                    </PayPalProvider>
                  ) : (
                    <p className="rounded-xl bg-bad-soft p-3 text-sm text-bad">NEXT_PUBLIC_PAYPAL_CLIENT_ID is not set, so PayPal buttons can&apos;t load.</p>
                  )}
                  <button
                    onClick={reject}
                    disabled={busy}
                    className="mt-3 w-full rounded-xl border border-line py-2.5 text-sm text-muted hover:border-bad hover:text-bad disabled:opacity-50"
                  >
                    Reject this purchase
                  </button>
                </div>
              ) : (
                <div className={`mt-6 rounded-xl p-4 text-sm ${meta.className}`}>
                  {tx.status === "PAID" && <>Approved and paid with PayPal. Capture <span className="font-mono text-xs">{tx.paypalCaptureId}</span></>}
                  {tx.status === "REJECTED" && "You rejected this purchase. Nothing was charged."}
                  {tx.status === "REFUNDED" && "This purchase was refunded."}
                  {tx.status === "FAILED" && "The payment failed. Nothing was charged."}
                  {tx.status === "BLOCKED" && "This purchase was blocked by your rules."}
                  {tx.status === "PROCESSING" && "Payment is processing…"}
                  <div className="mt-3">
                    <Link href="/" className="font-medium underline underline-offset-2">
                      Back to dashboard
                    </Link>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <p className="mt-4 text-center text-xs text-muted">Payments run in the PayPal sandbox. Use a sandbox personal account to approve.</p>
      </div>
    </div>
  );
}
