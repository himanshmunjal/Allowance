"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { AttackReport, AttackResult, DecisionCheck } from "@shared/types";
import { api, money } from "@/app/components/format";

// The Attack Lab (D-065): real attacks on the real pipeline, in throwaway accounts, with PayPal unplugged.

const REVEAL_MS = 180;

export default function LabView() {
  const [total, setTotal] = useState<number | null>(null);
  const [report, setReport] = useState<AttackReport | null>(null);
  const [shown, setShown] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api<{ total: number }>("/api/lab").then((r) => setTotal(r.total)).catch((err) => setError(err.message));
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  async function run() {
    setRunning(true);
    setError(null);
    setReport(null);
    setShown(0);
    try {
      const r = await api<AttackReport>("/api/lab/run", { method: "POST" });
      setReport(r);
      // The server has finished; reveal one by one so a person can follow along.
      timer.current = setInterval(() => {
        setShown((n) => {
          if (n >= r.results.length) {
            if (timer.current) clearInterval(timer.current);
            setRunning(false);
            return n;
          }
          return n + 1;
        });
      }, REVEAL_MS);
    } catch (err) {
      setError((err as Error).message);
      setRunning(false);
    }
  }

  const done = report !== null && shown >= report.results.length;
  const visible = report?.results.slice(0, shown) ?? [];
  const stopped = visible.filter((r) => r.defended).length;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <Link href="/" className="text-xs text-muted hover:text-ink">
        ← Dashboard
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Attack Lab</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        {total ?? "These"} attacks on the same pipeline your agents use. Each runs in a throwaway account with PayPal unplugged, so nothing here can touch your ledger or move money.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        On attacks marked <Layer layer="code" />, the AI reviewer is rigged to approve everything, so only the code can stop them. <Layer layer="ai" /> uses the real reviewer.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-4">
        <button onClick={run} disabled={running} className="rounded-xl bg-brand-ink px-4 py-2.5 text-sm font-semibold text-on-accent hover:opacity-90 disabled:opacity-60">
          {running ? "Attacking…" : report ? "Run again" : "Run every attack"}
        </button>
        {report && (
          <p className="text-sm" aria-live="polite">
            <b className="text-lg tabular-nums">
              {stopped} of {report.total}
            </b>{" "}
            <span className="text-muted">{done ? "stopped, live, just now" : "stopped so far"}</span>
          </p>
        )}
      </div>
      {error && <p className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">{error}</p>}

      {visible.length > 0 && (
        <ol className="mt-6 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
          {visible.map((r) => (
            <AttackRow key={r.id} result={r} />
          ))}
        </ol>
      )}
    </div>
  );
}

function Layer({ layer }: { layer: AttackResult["layer"] }) {
  return layer === "code" ? (
    <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] font-medium text-ink ring-1 ring-line">code only</span>
  ) : (
    <span className="rounded bg-ai-soft px-1.5 py-0.5 text-[11px] font-medium text-ai">real AI</span>
  );
}

function AttackRow({ result: r }: { result: AttackResult }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-panel-2">
        <span
          aria-hidden
          className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold text-on-accent ${r.defended ? "bg-ok" : "bg-bad"}`}
        >
          {r.defended ? "✓" : "✕"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {r.title} <Layer layer={r.layer} />
            <span className="sr-only">{r.defended ? "stopped" : "got through"}</span>
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted">{r.outcome}</span>
        </span>
      </button>
      {open && (
        <div className="space-y-2.5 border-t border-line bg-panel-2 px-4 py-3 text-xs leading-relaxed">
          <Field label="The attack">{r.attack}</Field>
          <Field label="Must happen">{r.expected}</Field>
          <Field label="Auto-paid without a person (simulated)">{money(r.autoPaid)}</Field>
          {r.checks.length > 0 && (
            <div>
              <div className="text-muted">What the pipeline did</div>
              <ul className="mt-1 space-y-1">
                {r.checks.map((c, i) => (
                  <Check key={i} check={c} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Check({ check: c }: { check: DecisionCheck }) {
  const tone = c.outcome === "pass" ? "text-ok" : c.outcome === "ask" ? "text-warn" : c.outcome === "block" ? "text-bad" : "text-muted";
  const mark = c.outcome === "pass" ? "✓" : c.outcome === "ask" ? "?" : c.outcome === "block" ? "✕" : "–";
  return (
    <li className="flex gap-2">
      <span aria-hidden className={`w-3 shrink-0 text-center font-bold ${tone}`}>
        {mark}
      </span>
      <span>
        <b className="font-medium">{c.label}</b> <span className="text-muted">{c.detail}</span>
      </span>
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div>{children}</div>
    </div>
  );
}
