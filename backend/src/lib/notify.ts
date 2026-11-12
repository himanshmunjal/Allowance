import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { config } from "./config";
import { query, queryOne } from "./db";

// Approval alerts (D-075). An owner can give Allowance a webhook URL (a Zapier "Catch Hook", a Slack
// incoming webhook, anything that accepts a JSON POST). Allowance posts to it when a person is needed:
// a purchase is waiting for approval, or a payment failed. Blocked purchases stay quiet.
//
// The server calls a URL a user typed, so this is written to not become a way to reach the server's own
// network (server-side request forgery): https only, no private or internal addresses, no redirects, a short
// timeout, and the address is checked at the moment of connecting, so a name that changes its answer
// between "check" and "connect" can't get through.

export type AlertEvent = "approval_needed" | "payment_failed" | "test";

export type AlertPurchase = {
  id: string;
  title: string;
  merchant: string;
  amount: number;
  currency: string;
  agent: string | null;
  status: string;
  reasons: string[];
};

const TIMEOUT_MS = 5000;
const MAX_URL_LENGTH = 500;

// Addresses that are never a legitimate public webhook. (IPv4-mapped IPv6 is unwrapped before checking.)
const blocked = new net.BlockList();
for (const [net4, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including cloud metadata services
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
] as const) {
  blocked.addSubnet(net4, bits, "ipv4");
}
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6"); // unique local
blocked.addSubnet("fe80::", 10, "ipv6"); // link-local
blocked.addSubnet("ff00::", 8, "ipv6"); // multicast

/** True for an address that points inside a private or reserved range. */
export function isBlockedAddress(address: string): boolean {
  let ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const dotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) ip = dotted[1];
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    ip = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const family = net.isIP(ip);
  if (family === 0) return true; // not an address we understand: refuse
  return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** The checks that need no network. Dev and tests can allow local addresses with NOTIFY_ALLOW_PRIVATE=on. */
export function checkWebhookUrl(raw: string): UrlCheck {
  const allowPrivate = config.notify.allowPrivate();
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: "That address is too long." };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "That doesn't look like a web address." };
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) return { ok: false, reason: "The address must start with https://" };
  if (url.username || url.password) return { ok: false, reason: "Leave passwords out of the address. Use a hook URL that carries its own secret." };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!allowPrivate) {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".") && net.isIP(host) === 0) {
      return { ok: false, reason: "That address points to a private network, which can't be used." };
    }
    if (net.isIP(host) !== 0 && isBlockedAddress(host)) return { ok: false, reason: "That address points to a private network, which can't be used." };
  }
  return { ok: true, url };
}

/** A DNS lookup that refuses private answers, used when connecting so the check and the connection can't disagree. */
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address, family);
    const list = Array.isArray(address) ? address.map((a) => a.address) : [address as string];
    if (!config.notify.allowPrivate() && list.some(isBlockedAddress)) {
      return callback(new Error("That address points to a private network."), "", 0);
    }
    callback(null, address as never, family as never);
  });
};

/** POSTs JSON. Never follows a redirect, gives up after a few seconds, ignores the response body. */
export function postJson(url: URL, payload: unknown): Promise<{ status: number }> {
  const body = JSON.stringify(payload);
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "POST",
        timeout: TIMEOUT_MS,
        lookup: safeLookup,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "User-Agent": "Allowance-Alerts/1.0" },
      },
      (res) => {
        res.resume(); // we only care that it arrived
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("The webhook took too long to answer.")));
    req.on("error", reject);
    req.end(body);
  });
}

// ---------- the owner's saved address ----------

/** What the owner sees: whether alerts are on and where, never the full URL (hook URLs carry a secret). */
export async function getAlertSettings(userId: string): Promise<{ configured: boolean; host: string | null }> {
  const row = await queryOne<{ notify_webhook_url: string | null }>("SELECT notify_webhook_url FROM users WHERE id = $1", [userId]);
  if (!row?.notify_webhook_url) return { configured: false, host: null };
  try {
    return { configured: true, host: new URL(row.notify_webhook_url).hostname };
  } catch {
    return { configured: false, host: null };
  }
}

/** Saves (or clears, with null) the address. Throws a plain-language Error when it can't be used. */
export async function setAlertUrl(userId: string, raw: string | null): Promise<void> {
  if (raw === null) {
    await query("UPDATE users SET notify_webhook_url = NULL WHERE id = $1", [userId]);
    return;
  }
  const checked = checkWebhookUrl(raw);
  if (!checked.ok) throw new AlertAddressError(checked.reason);
  // Names get one more look now, so the owner hears about a bad address straight away.
  const host = checked.url.hostname.replace(/^\[|\]$/g, "");
  if (!config.notify.allowPrivate() && net.isIP(host) === 0) {
    const answers = await dns.promises.lookup(host, { all: true }).catch(() => []);
    if (answers.length === 0) throw new AlertAddressError("That address couldn't be found.");
    if (answers.some((a) => isBlockedAddress(a.address))) throw new AlertAddressError("That address points to a private network, which can't be used.");
  }
  await query("UPDATE users SET notify_webhook_url = $2 WHERE id = $1", [userId, checked.url.toString()]);
}

export class AlertAddressError extends Error {}

// ---------- sending ----------

function payloadFor(event: AlertEvent, purchase: AlertPurchase | null) {
  const money = purchase ? `$${purchase.amount.toFixed(2)}` : "";
  const text =
    event === "test"
      ? "Allowance test alert: if you can read this, approval alerts are working."
      : event === "approval_needed"
        ? `${purchase!.title} (${money}) is waiting for your approval${purchase!.agent ? ` from ${purchase!.agent}` : ""}.`
        : `A payment for ${purchase!.title} (${money}) failed. Nothing was charged.`;
  return {
    text, // Slack and many tools show this field; Zapier receives every field
    event,
    purchase,
    approvalUrl: event === "approval_needed" && purchase ? `${config.appUrl()}/approve/${purchase.id}` : null,
    sentAt: new Date().toISOString(),
  };
}

/** Sends the owner's alert if they set one up. Never throws and never delays a purchase. */
export async function notifyOwner(userId: string, event: AlertEvent, purchase: AlertPurchase | null): Promise<void> {
  try {
    const row = await queryOne<{ notify_webhook_url: string | null }>("SELECT notify_webhook_url FROM users WHERE id = $1", [userId]);
    if (!row?.notify_webhook_url) return;
    const checked = checkWebhookUrl(row.notify_webhook_url);
    if (!checked.ok) return;
    const { status } = await postJson(checked.url, payloadFor(event, purchase));
    if (status >= 300) console.warn(`[notify] ${checked.url.hostname} answered ${status}`);
  } catch (err) {
    console.warn(`[notify] alert not delivered: ${(err as Error).message}`); // never log the URL: it is a secret
  }
}

/** For the "Send a test" button: the same path as a real alert, but the result is reported back. */
export async function sendTestAlert(userId: string): Promise<{ ok: boolean; message: string }> {
  const row = await queryOne<{ notify_webhook_url: string | null }>("SELECT notify_webhook_url FROM users WHERE id = $1", [userId]);
  if (!row?.notify_webhook_url) return { ok: false, message: "Add an address first." };
  const checked = checkWebhookUrl(row.notify_webhook_url);
  if (!checked.ok) return { ok: false, message: checked.reason };
  try {
    const { status } = await postJson(checked.url, payloadFor("test", null));
    return status < 300 ? { ok: true, message: "Sent. Check the place it goes to." } : { ok: false, message: `The address answered with an error (${status}).` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
