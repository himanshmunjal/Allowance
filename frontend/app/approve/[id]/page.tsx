import { Suspense } from "react";
import ApproveView from "./ApproveView";

// Cache Components: await params inside <Suspense> so the static shell can prerender (D-017).
export default function ApprovePage({ params }: PageProps<"/approve/[id]">) {
  return (
    <Suspense fallback={<div className="p-10 text-center text-sm text-muted">Loading purchase…</div>}>
      <ApproveLoader params={params} />
    </Suspense>
  );
}

async function ApproveLoader({ params }: Pick<PageProps<"/approve/[id]">, "params">) {
  const { id } = await params;
  return <ApproveView id={id} />;
}
