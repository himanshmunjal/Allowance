"use client";

import { useState, type FormEvent } from "react";
import type { Agent, Category } from "@shared/types";
import { api, money, timeAgo } from "./format";

// Your agents and their allowances (D-054). Each external agent has its own API key and limits
// that sit on top of your rules: an agent can be stricter than your rules, never looser.

const CATEGORIES = ["coffee", "groceries", "gifts", "electronics", "books", "clothing", "home", "other"] as const satisfies readonly Category[];

type Draft = { name: string; weeklyBudget: string; autoPayLimit: string; allowedCategories: Category[]; alwaysAsk: boolean };

const emptyDraft: Draft = { name: "", weeklyBudget: "", autoPayLimit: "", allowedCategories: [], alwaysAsk: false };

const toDraft = (a: Agent): Draft => ({
  name: a.name,
  weeklyBudget: a.weeklyBudget === null ? "" : String(a.weeklyBudget),
  autoPayLimit: a.autoPayLimit === null ? "" : String(a.autoPayLimit),
  allowedCategories: a.allowedCategories,
  alwaysAsk: a.alwaysAsk,
});

const fromDraft = (d: Draft) => ({
  name: d.name.trim(),
  weeklyBudget: d.weeklyBudget.trim() === "" ? null : Number(d.weeklyBudget),
  autoPayLimit: d.autoPayLimit.trim() === "" ? null : Number(d.autoPayLimit),
  allowedCategories: d.allowedCategories,
  alwaysAsk: d.alwaysAsk,
});

export default function AgentsPanel({ agents, onChange }: { agents: Agent[]; onChange: () => void }) {
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<{ name: string; apiKey: string } | null>(null);

  return (
    <div className="space-y-3 p-4">
      {newKey && <KeyReveal {...newKey} onDone={() => setNewKey(null)} />}

      {creating ? (
        <AgentForm
          title="New agent"
          initial={emptyDraft}
          submitLabel="Create agent + key"
          onCancel={() => setCreating(false)}
          onSubmit={async (d) => {
            const r = await api<{ agent: Agent; apiKey: string }>("/api/agents", { method: "POST", body: JSON.stringify(fromDraft(d)) });
            setCreating(false);
            setNewKey({ name: r.agent.name, apiKey: r.apiKey });
            onChange();
          }}
        />
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="w-full rounded-xl border border-dashed border-line px-3 py-2.5 text-xs font-medium text-brand hover:border-brand hover:bg-brand-soft"
        >
          + New agent with its own allowance
        </button>
      )}

      {agents.map((a) => (
        <AgentCard key={a.id} agent={a} onChange={onChange} />
      ))}
    </div>
  );
}

function AgentCard({ agent, onChange }: { agent: Agent; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paused = agent.status === "paused";

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <AgentForm
        title={`Edit ${agent.name}`}
        initial={toDraft(agent)}
        submitLabel="Save allowance"
        lockName={agent.kind === "builtin"}
        onCancel={() => setEditing(false)}
        onSubmit={async (d) => {
          await api(`/api/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify(fromDraft(d)) });
          setEditing(false);
          onChange();
        }}
      />
    );
  }

  const used = agent.weeklyBudget ? Math.min(100, (agent.spentThisWeek / agent.weeklyBudget) * 100) : 0;

  return (
    <div className={`rounded-xl border border-line p-3 ${paused ? "bg-panel-2 opacity-80" : "bg-panel"}`}>
      <div className="flex items-start gap-2.5">
        <span className={`grid size-8 shrink-0 place-items-center rounded-lg text-sm ${agent.kind === "builtin" ? "bg-ai-soft text-ai" : "bg-brand-soft text-brand"}`}>
          {agent.kind === "builtin" ? "✦" : "⌁"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{agent.name}</span>
            {paused && <span className="rounded-full bg-warn-soft px-1.5 py-0.5 text-[10px] font-medium text-warn">paused</span>}
          </div>
          <div className="text-[11px] text-muted">
            {agent.kind === "builtin" ? "Chat on this dashboard" : `External · key …${agent.keyHint}`}
            {agent.lastUsedAt && agent.kind === "external" ? ` · used ${timeAgo(agent.lastUsedAt)}` : agent.kind === "external" ? " · never used" : ""}
          </div>
        </div>
        <div className="text-right text-xs">
          <b>{money(agent.spentThisWeek)}</b>
          <div className="text-[11px] text-muted">{agent.weeklyBudget === null ? "this week" : `of ${money(agent.weeklyBudget)}`}</div>
        </div>
      </div>

      {agent.weeklyBudget !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel-2 ring-1 ring-line">
          <div className={`h-full ${used >= 100 ? "bg-bad" : "bg-brand"}`} style={{ width: `${used}%` }} />
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
        {agent.autoPayLimit !== null && <Tag tone="ok">auto-pay ≤ {money(agent.autoPayLimit)}</Tag>}
        {agent.allowedCategories.length > 0 && <Tag>only {agent.allowedCategories.join(", ")}</Tag>}
        {agent.alwaysAsk && <Tag tone="warn">always ask</Tag>}
        {agent.weeklyBudget === null && agent.autoPayLimit === null && !agent.allowedCategories.length && !agent.alwaysAsk && (
          <Tag>no extra limits: your rules apply</Tag>
        )}
      </div>

      <div className="mt-2.5 flex items-center justify-end gap-1.5 text-[11px]">
        {error && <span className="mr-auto text-bad">{error}</span>}
        {confirmRevoke ? (
          <>
            <span className="mr-auto text-bad">Revoke for good? The key stops working now.</span>
            <button onClick={() => setConfirmRevoke(false)} className="px-2 py-1 text-muted hover:text-ink">
              Keep
            </button>
            <button
              onClick={() => run(() => api(`/api/agents/${agent.id}`, { method: "DELETE" }))}
              disabled={busy}
              className="rounded-lg bg-bad px-2 py-1 font-medium text-white disabled:opacity-50"
            >
              Revoke
            </button>
          </>
        ) : (
          <>
            <button onClick={() => setEditing(true)} className="rounded-lg px-2 py-1 text-brand hover:bg-brand-soft">
              Edit allowance
            </button>
            {agent.kind === "external" && (
              <>
                <button
                  onClick={() =>
                    run(() => api(`/api/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ status: paused ? "active" : "paused" }) }))
                  }
                  disabled={busy}
                  className="rounded-lg px-2 py-1 text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-50"
                >
                  {paused ? "▶ Resume" : "⏸ Pause"}
                </button>
                <button onClick={() => setConfirmRevoke(true)} className="rounded-lg px-2 py-1 text-muted hover:text-bad">
                  Revoke
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AgentForm({
  title,
  initial,
  submitLabel,
  lockName,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial: Draft;
  submitLabel: string;
  lockName?: boolean;
  onSubmit: (d: Draft) => Promise<void>;
  onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(d);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const toggle = (c: Category) =>
    setD({ ...d, allowedCategories: d.allowedCategories.includes(c) ? d.allowedCategories.filter((x) => x !== c) : [...d.allowedCategories, c] });

  const input = "mt-1 w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm outline-none focus:border-brand";

  return (
    <form onSubmit={submit} className="rounded-xl border border-brand/40 bg-panel p-3 text-xs">
      <div className="mb-2 font-semibold">{title}</div>
      {!lockName && (
        <label className="block">
          <span className="text-muted">Name</span>
          <input required minLength={2} maxLength={60} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. Grocery bot" className={input} />
        </label>
      )}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-muted">Weekly allowance ($)</span>
          <input type="number" min={0} step="0.01" inputMode="decimal" value={d.weeklyBudget} onChange={(e) => setD({ ...d, weeklyBudget: e.target.value })} placeholder="no limit" className={input} />
        </label>
        <label className="block">
          <span className="text-muted">Auto-pay up to ($)</span>
          <input type="number" min={0} step="0.01" inputMode="decimal" value={d.autoPayLimit} onChange={(e) => setD({ ...d, autoPayLimit: e.target.value })} placeholder="your rule" className={input} />
        </label>
      </div>
      <div className="mt-2">
        <span className="text-muted">May only buy (none selected = anything your rules allow)</span>
        <div className="mt-1 flex flex-wrap gap-1">
          {CATEGORIES.map((c) => (
            <button
              type="button"
              key={c}
              onClick={() => toggle(c)}
              className={`rounded-lg px-2 py-1 ${d.allowedCategories.includes(c) ? "bg-brand text-white" : "bg-panel-2 text-ink hover:bg-brand-soft"}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
      <label className="mt-2 flex items-center gap-2">
        <input type="checkbox" checked={d.alwaysAsk} onChange={(e) => setD({ ...d, alwaysAsk: e.target.checked })} />
        Always ask me before this agent pays
      </label>
      <p className="mt-2 text-[11px] text-muted">These limits add to your rules. They can only make things stricter, never looser.</p>
      {error && <p className="mt-2 text-bad">{error}</p>}
      <div className="mt-2.5 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-2.5 py-1.5 text-muted hover:text-ink">
          Cancel
        </button>
        <button type="submit" disabled={busy} className="rounded-lg bg-brand px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50">
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

function KeyReveal({ name, apiKey, onDone }: { name: string; apiKey: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl border border-ok/40 bg-ok-soft p-3 text-xs">
      <div className="font-semibold text-ok">“{name}” is ready. Copy its API key now</div>
      <p className="mt-0.5 text-muted">It won&apos;t be shown again. Give it only to this agent (e.g. as AGENT_API_KEY in its MCP config).</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-panel px-2 py-1.5 font-mono text-[11px]">{apiKey}</code>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(apiKey).then(() => setCopied(true));
          }}
          className="rounded-lg bg-ok px-2.5 py-1.5 font-medium text-white"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <button onClick={onDone} className="mt-2 text-[11px] text-muted hover:text-ink">
        I&apos;ve saved it
      </button>
    </div>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: "ok" | "warn" }) {
  const cls = tone === "ok" ? "bg-ok-soft text-ok" : tone === "warn" ? "bg-warn-soft text-warn" : "bg-panel-2 text-ink";
  return <span className={`rounded-md px-1.5 py-0.5 ${cls}`}>{children}</span>;
}
