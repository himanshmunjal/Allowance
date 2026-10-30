import { config } from "./config";

// Thin, typed client over the PayPal REST APIs we use (DECISION.md D-018).
// Every POST carries a PayPal-Request-Id so retries never double-charge.

export class PayPalError extends Error {
  constructor(
    message: string,
    public status: number,
    public name: string,
    public debugId: string | null,
    public details: unknown,
  ) {
    super(message);
  }
}

type Money = { currency_code: string; value: string };

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const basic = Buffer.from(`${config.paypal.clientId()}:${config.paypal.clientSecret()}`).toString("base64");
  const res = await fetch(`${config.paypal.apiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new PayPalError(
      "PayPal authentication failed: check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET",
      res.status,
      "AUTHENTICATION_FAILURE",
      res.headers.get("paypal-debug-id"),
      await res.text(),
    );
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

async function call<T>(method: string, path: string, opts: { body?: unknown; requestId?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;

  const res = await fetch(`${config.paypal.apiBase()}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const issue = json?.details?.[0];
    const message = issue ? `${issue.issue}: ${issue.description}` : json?.message ?? `PayPal ${method} ${path} failed`;
    throw new PayPalError(message, res.status, json?.name ?? "PAYPAL_ERROR", json?.debug_id ?? res.headers.get("paypal-debug-id"), json?.details);
  }
  return json as T;
}

const money = (value: number, currency: string): Money => ({ currency_code: currency, value: value.toFixed(2) });

// ---------- Orders v2 ----------

export type OrderInput = {
  txId: string;
  title: string;
  merchantName: string;
  productId: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  currency: string;
};

export type Order = {
  id: string;
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  purchase_units?: {
    custom_id?: string;
    payments?: { captures?: { id: string; status: string; amount: Money }[] };
  }[];
  payment_source?: {
    paypal?: {
      email_address?: string;
      // Present when the order saved the wallet (store_in_vault: ON_SUCCESS).
      attributes?: { vault?: { id?: string; status?: string; customer?: { id?: string } } };
    };
  };
  links?: { href: string; rel: string }[];
};

function purchaseUnit(o: OrderInput) {
  return {
    reference_id: o.txId,
    custom_id: o.txId,
    description: `${o.merchantName}: ${o.title}`.slice(0, 127),
    amount: {
      ...money(o.amount, o.currency),
      breakdown: { item_total: money(o.amount, o.currency) },
    },
    items: [
      {
        name: o.title.slice(0, 127),
        sku: o.productId,
        quantity: String(o.quantity),
        unit_amount: money(o.unitPrice, o.currency),
      },
    ],
  };
}

const experience = {
  brand_name: "Allowance",
  shipping_preference: "NO_SHIPPING",
  user_action: "PAY_NOW",
};

/**
 * Order for the human-approval page; the buyer approves it in the PayPal button popup.
 * With `saveWallet`, PayPal also saves the buyer's wallet on success ("save with purchase"),
 * which then enables auto-pay (DECISION.md D-046).
 */
export function createOrder(o: OrderInput, attempt: string, saveWallet?: { returnUrl: string; cancelUrl: string }) {
  return call<Order>("POST", "/v2/checkout/orders", {
    requestId: `${o.txId}-order-${attempt}`,
    body: {
      intent: "CAPTURE",
      purchase_units: [purchaseUnit(o)],
      payment_source: {
        paypal: {
          // PayPal requires return/cancel URLs whenever an order saves the wallet.
          experience_context: saveWallet
            ? { ...experience, return_url: saveWallet.returnUrl, cancel_url: saveWallet.cancelUrl }
            : experience,
          ...(saveWallet
            ? { attributes: { vault: { store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT", customer_type: "CONSUMER" } } }
            : {}),
        },
      },
    },
  });
}

/** Wallet saved by a "save with purchase" order, if PayPal returned one. */
export function vaultedWallet(order: Order) {
  const paypal = order.payment_source?.paypal;
  const vault = paypal?.attributes?.vault;
  return vault?.id ? { vaultId: vault.id, customerId: vault.customer?.id ?? null, email: paypal?.email_address ?? null } : null;
}

/** Merchant-initiated order paid with the vaulted PayPal wallet: no buyer interaction. */
export function createVaultedOrder(o: OrderInput, vaultId: string) {
  return call<Order>("POST", "/v2/checkout/orders", {
    requestId: `${o.txId}-vault-order`,
    body: {
      intent: "CAPTURE",
      purchase_units: [purchaseUnit(o)],
      payment_source: { paypal: { vault_id: vaultId } },
    },
  });
}

export function captureOrder(orderId: string, requestId: string) {
  return call<Order>("POST", `/v2/checkout/orders/${orderId}/capture`, { requestId, body: {} });
}

export function getOrder(orderId: string) {
  return call<Order>("GET", `/v2/checkout/orders/${orderId}`);
}

export function firstCapture(order: Order) {
  return order.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
}

// ---------- Payments: refunds ----------

export function refundCapture(captureId: string, amount: number, currency: string, txId: string) {
  return call<{ id: string; status: string }>("POST", `/v2/payments/captures/${captureId}/refund`, {
    requestId: `${txId}-refund`,
    body: {
      amount: money(amount, currency),
      note_to_payer: "Refunded from your Allowance dashboard",
    },
  });
}

// ---------- Vault v3: save PayPal wallet without a purchase ----------

export type SetupToken = { id: string; status: string; links: { href: string; rel: string }[] };

export function createSetupToken(returnUrl: string, cancelUrl: string, requestId: string) {
  return call<SetupToken>("POST", "/v3/vault/setup-tokens", {
    requestId,
    body: {
      payment_source: {
        paypal: {
          description: "Allowance: let your AI agent pay within the rules you set",
          usage_pattern: "IMMEDIATE",
          usage_type: "MERCHANT",
          customer_type: "CONSUMER",
          permit_multiple_payment_tokens: false,
          experience_context: {
            brand_name: "Allowance",
            shipping_preference: "NO_SHIPPING",
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    },
  });
}

export type PaymentToken = {
  id: string;
  customer?: { id: string };
  payment_source?: { paypal?: { email_address?: string; payer_id?: string } };
};

export function createPaymentToken(setupTokenId: string) {
  return call<PaymentToken>("POST", "/v3/vault/payment-tokens", {
    requestId: `${setupTokenId}-payment-token`,
    body: { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
  });
}

export function deletePaymentToken(id: string) {
  return call<unknown>("DELETE", `/v3/vault/payment-tokens/${id}`);
}

// ---------- Webhooks ----------

export async function verifyWebhook(headers: Headers, event: unknown): Promise<boolean> {
  const webhookId = config.paypal.webhookId();
  if (!webhookId) return false;
  const res = await call<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
    body: {
      auth_algo: headers.get("paypal-auth-algo"),
      cert_url: headers.get("paypal-cert-url"),
      transmission_id: headers.get("paypal-transmission-id"),
      transmission_sig: headers.get("paypal-transmission-sig"),
      transmission_time: headers.get("paypal-transmission-time"),
      webhook_id: webhookId,
      webhook_event: event,
    },
  });
  return res.verification_status === "SUCCESS";
}
