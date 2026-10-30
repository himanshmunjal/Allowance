// Central access to environment variables. Read lazily so `next build` works without secrets.

import type { ProviderId } from "./llm/types";

function optional(name: string, fallback = ""): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) {
    throw new ConfigError(`Missing environment variable ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

export class ConfigError extends Error {}

const PROVIDERS: ProviderId[] = ["gemini", "groq", "anthropic"];

function providerId(value: string, name: string): ProviderId {
  const id = value.toLowerCase();
  if (!PROVIDERS.includes(id as ProviderId)) {
    throw new ConfigError(`${name}="${value}" is not one of: ${PROVIDERS.join(", ")}`);
  }
  return id as ProviderId;
}

export const config = {
  appUrl: () => optional("APP_URL", "http://localhost:3000").replace(/\/$/, ""),

  paypal: {
    clientId: () => required("PAYPAL_CLIENT_ID"),
    clientSecret: () => required("PAYPAL_CLIENT_SECRET"),
    apiBase: () => optional("PAYPAL_API_BASE", "https://api-m.sandbox.paypal.com"),
    webhookId: () => optional("PAYPAL_WEBHOOK_ID"),
  },

  // AI providers (DECISION.md D-032..D-034). Any one key is enough; free options first.
  llm: {
    /** Preferred provider; unset = first configured in the order gemini, groq, anthropic. */
    primary: (): ProviderId | null => {
      const v = optional("LLM_PROVIDER");
      return v ? providerId(v, "LLM_PROVIDER") : null;
    },
    /** Comma-separated fallback order; unset = every other configured provider. */
    fallbacks: (): ProviderId[] | null => {
      const v = optional("LLM_FALLBACKS");
      return v ? v.split(",").map((s) => providerId(s.trim(), "LLM_FALLBACKS")) : null;
    },
    gemini: { apiKey: () => optional("GEMINI_API_KEY"), model: () => optional("GEMINI_MODEL", "gemini-3.5-flash") },
    groq: { apiKey: () => optional("GROQ_API_KEY"), model: () => optional("GROQ_MODEL", "openai/gpt-oss-120b") },
    anthropic: { apiKey: () => optional("ANTHROPIC_API_KEY"), model: () => optional("ANTHROPIC_MODEL", "claude-opus-5-5") },
  },

  /**
   * "autopay" (default): run the AI risk check only when a purchase would be paid automatically;
   * purchases a human reviews anyway skip it (saves free-tier quota). "always": check every purchase.
   */
  riskCheck: (): "autopay" | "always" => (optional("RISK_CHECK", "autopay") === "always" ? "always" : "autopay"),

  // Live catalog (D-050). No key = demo catalog only. CATALOG_SOURCE=demo forces the demo catalog.
  channel3: { apiKey: () => optional("CHANNEL3_API_KEY") },
  catalogSource: (): "channel3" | "demo" => (optional("CATALOG_SOURCE", "channel3") === "demo" ? "demo" : "channel3"),

  /**
   * Optional. On the first sign-up, this key becomes that account's first external agent so the
   * MCP server and scripts (which send it) work without reconfiguring (D-054).
   */
  legacyAgentKey: () => optional("AGENT_API_KEY"),
  /** Key an external store uses to create checkout quotes (D-051). Separate from the agent's key. */
  merchantApiKey: () => required("MERCHANT_API_KEY"),
  /** PostgreSQL connection string (D-055), e.g. postgres://postgres:<password>@localhost:5432/allowance */
  databaseUrl: () => required("DATABASE_URL"),
  /** Mark the session cookie Secure when the app is served over https. */
  secureCookies: () => optional("APP_URL", "http://localhost:3000").startsWith("https://"),
};
