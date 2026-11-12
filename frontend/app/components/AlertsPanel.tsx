"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api } from "./format";

type Settings = { configured: boolean; host: string | null };
type Note = { tone: "ok" | "bad"; text: string };

// Approval alerts (D-075): an owner pastes a webhook address (a Zapier Catch Hook, a Slack incoming webhook,
// anything that takes a JSON POST) and gets pinged when a purchase needs them. The saved address is never
// shown again: hook URLs carry a secret, so only the host is displayed.
export default function AlertsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  useEffect(() => {
    api<Settings>("/api/notify")
      .then(setSettings)
      .catch(() => setSettings(null)); // optional panel: if it can't load, it just doesn't show
  }, []);

  if (!settings) return null;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const next = await api<Settings>("/api/notify", { method: "PUT", body: JSON.stringify({ url: url.trim() || null }) });
      setSettings(next);
      setUrl("");
      setNote({ tone: "ok", text: next.configured ? "Saved. Use “Send a test” to check it arrives." : "Alerts are off." });
    } catch (err) {
      setNote({ tone: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setNote(null);
    try {
      setSettings(await api<Settings>("/api/notify", { method: "PUT", body: JSON.stringify({ url: null }) }));
      setNote({ tone: "ok", text: "Alerts are off." });
    } catch (err) {
      setNote({ tone: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setNote(null);
    try {
      const r = await api<{ ok: boolean; message: string }>("/api/notify/test", { method: "POST" });
      setNote({ tone: r.ok ? "ok" : "bad", text: r.message });
    } catch (err) {
      setNote({ tone: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="group rounded-xl border border-line bg-panel">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 text-sm font-medium">
        <span>Approval alerts</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-normal ${settings.configured ? "bg-ok-soft text-ok" : "bg-panel-2 text-muted"}`}>
          {settings.configured ? `On · ${settings.host}` : "Off"}
        </span>
      </summary>
      <div className="border-t border-line px-5 py-4">
        <p className="text-xs leading-relaxed text-muted">
          Get a message when your agent needs you: a purchase is waiting for approval, or a payment failed. Paste a webhook address from Zapier (a Webhooks &ldquo;Catch Hook&rdquo;), Slack, or any tool that accepts
          a JSON POST. Only https addresses on the public internet work, and the address is kept private.
        </p>
        <form onSubmit={save} className="mt-3 flex gap-2">
          <label className="sr-only" htmlFor="alert-url">
            Webhook address
          </label>
          <input
            id="alert-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            maxLength={500}
            placeholder={settings.configured ? "Paste a new address to replace it" : "https://hooks.zapier.com/hooks/catch/…"}
            className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-xs outline-none focus:border-brand"
          />
          <button type="submit" disabled={busy || !url.trim()} className="shrink-0 rounded-lg bg-brand-ink px-3 py-2 text-xs font-medium text-on-accent hover:opacity-90 disabled:opacity-50">
            Save
          </button>
        </form>
        {settings.configured && (
          <div className="mt-2 flex gap-3 text-xs">
            <button onClick={sendTest} disabled={busy} className="font-medium text-brand hover:underline disabled:opacity-50">
              Send a test
            </button>
            <button onClick={turnOff} disabled={busy} className="text-muted hover:text-bad disabled:opacity-50">
              Turn off
            </button>
          </div>
        )}
        {note && (
          <p role="status" className={`mt-2 rounded-lg px-3 py-2 text-xs ${note.tone === "ok" ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>
            {note.text}
          </p>
        )}
      </div>
    </details>
  );
}
