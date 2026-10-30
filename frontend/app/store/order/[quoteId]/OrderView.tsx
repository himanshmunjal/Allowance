"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, money } from "@/app/components/format";
import StoreLayout from "../../StoreLayout";

type Order = { status: string; amount: number; quantity: number; title: string; agent_name: string | null } | null;

const VIEW: Record<string, { icon: string; title: string; text: string }> = {
  PAID: { icon: "✅", title: "Order confirmed", text: "Paid through Allowance with PayPal. We'll start roasting." },
  PROCESSING: { icon: "⏳", title: "Payment in progress", text: "Allowance is completing the PayPal payment…" },
  PENDING_APPROVAL: { icon: "⏳", title: "Waiting for the account owner", text: "Allowance asked the owner to approve this order in PayPal. This page updates by itself." },
  BLOCKED: { icon: "⛔", title: "Declined by Allowance", text: "The buyer's spending rules don't allow this order. Nothing was charged." },
  REJECTED: { icon: "✋", title: "Not approved", text: "The order was rejected or withdrawn. Nothing was charged." },
  REFUNDED: { icon: "↩️", title: "Refunded", text: "This order was paid and then refunded." },
  FAILED: { icon: "⚠️", title: "Payment failed", text: "PayPal couldn't complete the payment. Nothing was charged." },
};

export default function OrderView({ quoteId }: { quoteId: string }) {
  const [order, setOrder] = useState<Order | undefined>(undefined);

  useEffect(() => {
    const load = () =>
      api<{ order: Order }>(`/api/store/orders/${quoteId}`)
        .then((r) => setOrder(r.order))
        .catch(() => setOrder(null));
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [quoteId]);

  const view = order ? VIEW[order.status] : null;

  return (
    <StoreLayout>
      <div className="mx-auto max-w-md rounded-2xl border border-[#e7dccf] bg-white p-6 text-center shadow-sm dark:border-[#33261c] dark:bg-[#21180f]">
        {order === undefined ? (
          <p className="text-sm">Checking your order…</p>
        ) : !order || !view ? (
          <>
            <div className="text-4xl">🛒</div>
            <h1 className="mt-2 font-serif text-2xl font-semibold">No payment yet</h1>
            <p className="mt-1 text-sm text-[#8a6f5c] dark:text-[#bfa48f]">This order hasn&apos;t been paid with Allowance.</p>
          </>
        ) : (
          <>
            <div className="text-4xl">{view.icon}</div>
            <h1 className="mt-2 font-serif text-2xl font-semibold">{view.title}</h1>
            <p className="mt-1 text-sm text-[#8a6f5c] dark:text-[#bfa48f]">{view.text}</p>
            <div className="mt-4 rounded-xl bg-[#f3eadf] p-3 text-sm dark:bg-[#2c2016]">
              {order.quantity > 1 ? `${order.quantity} × ` : ""}
              {order.title} · <b>{money(order.amount)}</b>
              {order.agent_name && <div className="mt-0.5 text-xs opacity-75">bought by the customer&apos;s agent “{order.agent_name}”</div>}
            </div>
          </>
        )}
        <Link href="/store" className="mt-5 inline-block text-sm underline">
          ← Continue shopping
        </Link>
      </div>
    </StoreLayout>
  );
}
