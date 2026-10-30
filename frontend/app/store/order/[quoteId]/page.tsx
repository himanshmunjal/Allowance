import { Suspense } from "react";
import OrderView from "./OrderView";

export default function OrderPage({ params }: PageProps<"/store/order/[quoteId]">) {
  return (
    <Suspense>
      <OrderLoader params={params} />
    </Suspense>
  );
}

async function OrderLoader({ params }: Pick<PageProps<"/store/order/[quoteId]">, "params">) {
  const { quoteId } = await params;
  return <OrderView quoteId={quoteId} />;
}
