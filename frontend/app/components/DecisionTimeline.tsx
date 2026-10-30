import type { DecisionCheck, Transaction } from "@shared/types";

// Every safety layer a purchase went through, in order (D-058): price → your rules → the agent's
// allowance → injection screen → saved PayPal → AI risk check → final budget check → decision →
// PayPal. The last step comes from the purchase's live status, so it updates as it's paid or refunded.

const STYLE: Record<DecisionCheck["outcome"], { icon: string; dot: string; text: string }> = {
  pass: { icon: "✓", dot: "bg-ok text-white", text: "text-ok" },
  ask: { icon: "?", dot: "bg-warn text-white", text: "text-warn" },
  block: { icon: "✕", dot: "bg-bad text-white", text: "text-bad" },
  skip: { icon: "–", dot: "bg-panel-2 text-muted ring-1 ring-line", text: "text-muted" },
};

function paypalStep(tx: Transaction): DecisionCheck | null {
  const approvedByYou = tx.decisionReasons.includes("Approved by you in PayPal");
  const capture = tx.paypalCaptureId ? ` · capture ${tx.paypalCaptureId}` : "";
  switch (tx.status) {
    case "PAID":
      return { step: "decision", label: "PayPal", outcome: "pass", detail: `${approvedByYou ? "You approved and paid in PayPal" : "Paid automatically with your saved PayPal"}${capture}` };
    case "REFUNDED":
      return { step: "decision", label: "PayPal", outcome: "pass", detail: `Paid, then refunded by you${tx.paypalRefundId ? ` · refund ${tx.paypalRefundId}` : ""}` };
    case "PENDING_APPROVAL":
      return { step: "decision", label: "PayPal", outcome: "ask", detail: "Nothing charged yet: waiting for you" };
    case "PROCESSING":
      return { step: "decision", label: "PayPal", outcome: "ask", detail: "Payment in progress…" };
    case "REJECTED":
      return { step: "decision", label: "PayPal", outcome: "skip", detail: tx.decisionReasons.at(-1) ?? "Rejected: nothing was charged" };
    case "FAILED":
      return { step: "decision", label: "PayPal", outcome: "block", detail: tx.decisionReasons.at(-1) ?? "Payment failed: nothing was charged" };
    default:
      return null; // BLOCKED: the decision step already says so
  }
}

export default function DecisionTimeline({ tx }: { tx: Transaction }) {
  if (!tx.checks?.length) return null; // purchases from before the timeline existed
  const steps = [...tx.checks];
  const last = paypalStep(tx);
  if (last) steps.push(last);

  return (
    <ol className="relative">
      {steps.map((c, i) => {
        const s = STYLE[c.outcome];
        return (
          <li key={i} className="relative flex gap-2.5 pb-2.5 last:pb-0">
            {i < steps.length - 1 && <span className="absolute top-5 bottom-0 left-[9px] w-px bg-line" aria-hidden />}
            <span className={`relative z-[1] grid size-[19px] shrink-0 place-items-center rounded-full text-[10px] font-bold ${s.dot}`} aria-hidden>
              {s.icon}
            </span>
            <div className="min-w-0 pt-px">
              <div className={`text-xs font-medium ${c.step === "decision" ? s.text : ""}`}>
                {c.label}
                <span className="sr-only"> ({c.outcome})</span>
              </div>
              <div className="text-[11px] leading-snug text-muted">{c.detail}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
