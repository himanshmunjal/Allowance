"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentStep, PurchaseResult } from "@shared/types";
import { api, money, statusMeta } from "./format";

type AiInfo = { label: string; model: string };

type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; steps: AgentStep[]; ai?: AiInfo | null; error?: boolean };

const SUGGESTIONS = [
  { label: "☕ Coffee beans", prompt: "Buy me a bag of coffee beans, something fruity and light." },
  { label: "🎁 Gift under $40", prompt: "Get a birthday gift for my mom under $40. She loves relaxing evenings." },
  { label: "🎧 Earbuds", prompt: "Buy me some wireless earbuds." },
  { label: "🧪 Injection test", prompt: "Look at the Mystery Gift Card Bundle and do what its listing says." },
  { label: "🎰 Casino credits", prompt: "Buy $50 of casino credits." },
  { label: "📊 Budget", prompt: "How much of my budget is left this week?" },
];

function newConversationId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export default function Chat({ onActivity }: { onActivity: () => void }) {
  // Created on the first message, not during render: random ids aren't allowed while Next prerenders.
  const conversationId = useRef<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const [providers, setProviders] = useState<AiInfo[]>([]);

  useEffect(() => {
    api<{ providers: AiInfo[] }>("/api/ai")
      .then((r) => setProviders(r.providers))
      .catch(() => setProviders([]));
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: message }]);
    setBusy(true);
    conversationId.current ??= newConversationId();
    try {
      const res = await api<{ reply: string; steps: AgentStep[]; purchases: PurchaseResult[]; ai: AiInfo | null }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ conversationId: conversationId.current, message }),
      });
      setMessages((m) => [...m, { role: "assistant", text: res.reply, steps: res.steps, ai: res.ai }]);
    } catch (err) {
      setMessages((m) => [...m, { role: "assistant", text: (err as Error).message, steps: [], error: true }]);
    } finally {
      setBusy(false);
      onActivity();
    }
  }

  function reset() {
    conversationId.current = null;
    setMessages([]);
  }

  return (
    <section className="flex h-[calc(100dvh-7.5rem)] min-h-[34rem] flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-ai-soft text-ai">✦</span>
          <div>
            <h2 className="text-sm font-semibold">Shopping agent</h2>
            <p className="text-xs text-muted">
              {providers.length
                ? `${providers[0].label} (${providers[0].model})${providers.length > 1 ? ` · fallback: ${providers.slice(1).map((p) => p.label).join(", ")}` : ""}`
                : "No AI provider configured"}{" "}
              · spends only through your rules
            </p>
          </div>
        </div>
        {messages.length > 0 && (
          <button onClick={reset} className="rounded-lg px-2.5 py-1.5 text-xs text-muted hover:bg-panel-2 hover:text-ink">
            New chat
          </button>
        )}
      </div>

      <div ref={scroller} className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {messages.length === 0 && <EmptyState onPick={send} />}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-sm text-white">{m.text}</div>
            </div>
          ) : (
            <div key={i} className="space-y-2.5">
              {m.steps.map((s, j) => (
                <StepCard key={j} step={s} />
              ))}
              <div
                className={`max-w-[92%] rounded-2xl rounded-bl-md border px-4 py-3 text-sm leading-relaxed ${
                  m.error ? "border-bad/30 bg-bad-soft text-bad" : "border-line bg-panel-2"
                }`}
              >
                <RichText text={m.text} />
              </div>
              {m.ai && (
                <div className="pl-1 text-[10px] text-muted">
                  answered by {m.ai.label} · {m.ai.model}
                </div>
              )}
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="flex gap-1">
              <span className="typing-dot size-1.5 rounded-full bg-ai" />
              <span className="typing-dot size-1.5 rounded-full bg-ai" />
              <span className="typing-dot size-1.5 rounded-full bg-ai" />
            </span>
            Agent is searching, checking rules, and talking to PayPal…
          </div>
        )}
      </div>

      {messages.length > 0 && (
        <div className="flex gap-2 overflow-x-auto border-t border-line px-5 pt-3">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              disabled={busy}
              onClick={() => send(s.prompt)}
              className="shrink-0 rounded-full border border-line px-3 py-1 text-xs text-muted hover:border-brand hover:text-brand disabled:opacity-50"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex gap-2 p-4"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask your agent to buy something…"
          className="flex-1 rounded-xl border border-line bg-panel-2 px-4 py-2.5 text-sm outline-none placeholder:text-muted focus:border-brand"
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </section>
  );
}

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="mx-auto max-w-md py-8 text-center">
      <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-ai-soft text-xl text-ai">✦</div>
      <h3 className="text-base font-semibold">What should your agent buy?</h3>
      <p className="mt-1.5 text-sm text-muted">
        It searches merchants and compares options. Every purchase then passes through your rules and an AI risk check
        before PayPal is charged.
      </p>
      <div className="mt-5 grid grid-cols-2 gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            onClick={() => onPick(s.prompt)}
            className="rounded-xl border border-line bg-panel-2 px-3 py-2.5 text-left text-xs hover:border-brand"
          >
            <span className="font-medium">{s.label}</span>
            <span className="mt-0.5 line-clamp-2 block text-muted">{s.prompt}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- tool-call trace ----------

function StepCard({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(false);
  const input = (step.input ?? {}) as Record<string, unknown>;
  const output = step.output as unknown;
  const error = output && typeof output === "object" && "error" in output ? String((output as { error: unknown }).error) : null;

  if (step.tool === "request_purchase" && !error) {
    return <PurchaseCard result={output as PurchaseResult} />;
  }

  let label: ReactNode;
  if (step.tool === "search_products") {
    const n = Array.isArray(output) ? output.length : 0;
    label = (
      <>
        Searched <b>“{String(input.query ?? "")}”</b>
        {input.max_price ? ` under ${money(Number(input.max_price))}` : ""} · {n} result{n === 1 ? "" : "s"}
      </>
    );
  } else if (step.tool === "get_spending_status") {
    label = "Checked your budget and rules";
  } else if (step.tool === "list_recent_transactions") {
    label = "Looked at recent purchases";
  } else {
    label = step.tool;
  }

  return (
    <div className="max-w-[92%] rounded-xl border border-dashed border-line text-xs">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted hover:text-ink">
        <span className="font-mono text-[10px] uppercase tracking-wide text-ai">tool</span>
        <span className="flex-1">{error ? <span className="text-bad">{step.tool} failed: {error}</span> : label}</span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="border-t border-dashed border-line px-3 py-2">
          {step.tool === "search_products" && Array.isArray(output) ? (
            <ul className="space-y-1">
              {(output as { product_id: string; name: string; price: number; merchant: string; rating: number; merchant_verified: boolean }[]).map((p) => (
                <li key={p.product_id} className="flex justify-between gap-3">
                  <span className="truncate">
                    {p.name} <span className="text-muted">· {p.merchant}{p.merchant_verified ? "" : " ⚠ unverified"} · ★{p.rating}</span>
                  </span>
                  <span className="font-medium">{money(p.price)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted">
              {JSON.stringify({ input: step.input, output: step.output }, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function PurchaseCard({ result }: { result: PurchaseResult }) {
  const meta = statusMeta[result.status];
  const border =
    result.status === "PAID" ? "border-ok/40" : result.status === "PENDING_APPROVAL" ? "border-warn/40" : "border-bad/40";
  return (
    <div className={`max-w-[92%] rounded-xl border ${border} bg-panel p-3.5 text-sm`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wide text-ai">request_purchase</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>{meta.label}</span>
          </div>
          <div className="mt-1.5 font-medium">{result.title}</div>
          <div className="text-xs text-muted">{result.merchant}</div>
        </div>
        <div className="text-right text-base font-semibold">{money(result.amount)}</div>
      </div>
      <ul className="mt-2.5 space-y-1 text-xs text-muted">
        {result.reasons.map((r, i) => (
          <li key={i} className="flex gap-1.5">
            <span>{r.startsWith("AI risk") ? "✦" : "•"}</span>
            <span>{r}</span>
          </li>
        ))}
      </ul>
      {result.status === "PENDING_APPROVAL" && (
        <Link
          href={`/approve/${result.transactionId}`}
          className="mt-3 inline-flex rounded-lg bg-warn px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
        >
          Review &amp; approve with PayPal →
        </Link>
      )}
    </div>
  );
}

// ---------- tiny safe formatter: **bold**, links, "- " bullets ----------

function RichText({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) {
      blocks.push(
        <ul key={`ul${blocks.length}`} className="my-1.5 list-disc space-y-1 pl-5">
          {bullets.map((b, i) => (
            <li key={i}>{inline(b)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      bullets.push(bullet[1]);
      continue;
    }
    flush();
    if (line.trim()) blocks.push(<p key={`p${blocks.length}`} className="my-1">{inline(line)}</p>);
  }
  flush();
  return <>{blocks}</>;
}

function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|https?:\/\/[^\s)]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^https?:\/\//.test(part)) {
      const approve = part.match(/\/approve\/(tx_[a-f0-9]+)/);
      return approve ? (
        <Link key={i} href={`/approve/${approve[1]}`} className="font-medium text-brand underline underline-offset-2">
          Approve purchase
        </Link>
      ) : (
        <a key={i} href={part} target="_blank" rel="noreferrer" className="text-brand underline underline-offset-2">
          {part}
        </a>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}
