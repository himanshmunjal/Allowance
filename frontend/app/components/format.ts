import type { TxStatus } from "@shared/types";

export const money = (n: number) => `$${n.toFixed(2)}`;

export function timeAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export const statusMeta: Record<TxStatus, { label: string; className: string; dot: string }> = {
  PAID: { label: "Paid", className: "bg-ok-soft text-ok", dot: "bg-ok" },
  PROCESSING: { label: "Processing", className: "bg-brand-soft text-brand", dot: "bg-brand" },
  PENDING_APPROVAL: { label: "Needs approval", className: "bg-warn-soft text-warn", dot: "bg-warn" },
  BLOCKED: { label: "Blocked", className: "bg-bad-soft text-bad", dot: "bg-bad" },
  REJECTED: { label: "Rejected", className: "bg-panel-2 text-muted", dot: "bg-muted" },
  REFUNDED: { label: "Refunded", className: "bg-panel-2 text-muted", dot: "bg-muted" },
  FAILED: { label: "Failed", className: "bg-bad-soft text-bad", dot: "bg-bad" },
};

/** Error from our API, with the HTTP status (e.g. 409 = a hint, not a failure). */
export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  // Session missing or expired: go to the login page and come back here afterwards (D-053).
  if (res.status === 401 && !path.startsWith("/api/auth/") && typeof window !== "undefined") {
    window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`); // outside React: hard redirect
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error ?? `Request failed (${res.status})`, res.status);
  return json as T;
}

/** A same-site path from a ?return= / ?next= parameter, or null: never send people to another site. */
export function safePath(value: string | null | undefined): string | null {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : null;
}
