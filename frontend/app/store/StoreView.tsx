"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, money } from "@/app/components/format";
import StoreLayout, { AllowanceButton } from "./StoreLayout";

type Product = { id: string; name: string; description: string; price: number; category: string; emoji: string; rating: number; deliveryDays: number };

export default function StoreView() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ products: Product[] }>("/api/store/products")
      .then((r) => setProducts(r.products))
      .catch((err: Error) => setError(err.message));
  }, []);

  async function payWithAllowance(p: Product) {
    setBusy(p.id);
    setError(null);
    try {
      // The STORE prices the order (server-side quote), then hands over to Allowance Checkout.
      const r = await api<{ checkoutUrl: string }>("/api/store/checkout", {
        method: "POST",
        body: JSON.stringify({ productId: p.id, quantity: qty[p.id] ?? 1 }),
      });
      router.push(r.checkoutUrl);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  return (
    <StoreLayout>
      <h1 className="font-serif text-3xl font-semibold">Fresh roasts &amp; gear</h1>
      <p className="mt-1 text-sm text-[#8a6f5c] dark:text-[#bfa48f]">
        Let your AI agent shop here: we accept <b>Pay with Allowance</b>, so it can only spend within the rules you set.
      </p>
      {error && <p className="mt-4 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{error}</p>}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {products.map((p) => (
          <div key={p.id} className="flex flex-col rounded-2xl border border-[#e7dccf] bg-white p-4 shadow-sm dark:border-[#33261c] dark:bg-[#21180f]">
            <div className="grid h-28 place-items-center rounded-xl bg-[#f3eadf] text-5xl dark:bg-[#2c2016]">{p.emoji}</div>
            <div className="mt-3 flex items-start justify-between gap-2">
              <div className="font-medium leading-snug">{p.name}</div>
              <div className="font-semibold">{money(p.price)}</div>
            </div>
            <p className="mt-1 flex-1 text-xs text-[#8a6f5c] dark:text-[#bfa48f]">{p.description}</p>
            <div className="mt-1 text-[11px] text-[#8a6f5c] dark:text-[#bfa48f]">
              ★ {p.rating} · ships in {p.deliveryDays} days · {p.category}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <label className="sr-only" htmlFor={`qty-${p.id}`}>
                Quantity
              </label>
              <select
                id={`qty-${p.id}`}
                value={qty[p.id] ?? 1}
                onChange={(e) => setQty({ ...qty, [p.id]: Number(e.target.value) })}
                className="rounded-lg border border-[#e7dccf] bg-transparent px-2 py-2 text-sm dark:border-[#33261c]"
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <AllowanceButton disabled={busy !== null} onClick={() => payWithAllowance(p)}>
                {busy === p.id ? "Opening Allowance…" : "Pay with Allowance"}
              </AllowanceButton>
            </div>
          </div>
        ))}
      </div>

      <details className="mt-8 rounded-xl border border-[#e7dccf] p-4 text-xs dark:border-[#33261c]">
        <summary className="cursor-pointer font-medium">For AI agents: how to buy here</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-[#8a6f5c] dark:text-[#bfa48f]">
          <li>
            <code>GET /api/store/products</code> lists products.
          </li>
          <li>
            <code>POST /api/store/checkout</code> with <code>{"{ productId, quantity }"}</code> returns a <code>quoteId</code>: our price for the order.
          </li>
          <li>
            Call Allowance&apos;s MCP tool <code>request_purchase</code> with <code>product_id = quoteId</code>. Allowance applies the user&apos;s rules and
            pays us with PayPal, asks the user, or declines.
          </li>
        </ol>
      </details>
    </StoreLayout>
  );
}
