import type { Metadata } from "next";
import { Suspense } from "react";
import CheckoutView from "./CheckoutView";

export const metadata: Metadata = { title: "Allowance Checkout" };

// Cache Components: await params inside <Suspense> so the static shell can prerender (D-017).
export default function CheckoutPage({ params }: PageProps<"/checkout/[quoteId]">) {
  return (
    <Suspense fallback={<div className="p-10 text-center text-sm text-muted">Loading checkout…</div>}>
      <CheckoutLoader params={params} />
    </Suspense>
  );
}

async function CheckoutLoader({ params }: Pick<PageProps<"/checkout/[quoteId]">, "params">) {
  const { quoteId } = await params;
  return <CheckoutView quoteId={quoteId} />;
}
