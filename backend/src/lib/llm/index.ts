import { config } from "../config";
import { anthropicProvider } from "./anthropic";
import { openAICompatProvider } from "./openai-compat";
import { LlmError, type ChatOutput, type ChatRequest, type JsonRequest, type LlmProvider, type ProviderId } from "./types";

export * from "./types";

// Provider chain: the primary provider (LLM_PROVIDER) first, then the fallbacks. If a provider is
// rate-limited, down, or misconfigured, the next one answers instead (DECISION.md D-034).

const ORDER: ProviderId[] = ["gemini", "groq", "anthropic"];

function build(id: ProviderId): LlmProvider | null {
  const c = config.llm[id];
  const apiKey = c.apiKey();
  if (!apiKey) return null;
  const model = c.model();
  switch (id) {
    case "anthropic":
      return anthropicProvider(apiKey, model);
    case "gemini":
      return openAICompatProvider({
        id,
        label: "Gemini",
        apiKey,
        model,
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
        reasoningEffort: "low",
        jsonSchemaFormat: true,
      });
    case "groq":
      return openAICompatProvider({
        id,
        label: "Groq",
        apiKey,
        model,
        baseURL: "https://api.groq.com/openai/v1",
        // gpt-oss models take reasoning_effort; Llama/Qwen models reject it.
        reasoningEffort: model.includes("gpt-oss") ? "low" : null,
        jsonSchemaFormat: false,
      });
  }
}

let cached: { key: string; chain: LlmProvider[] } | null = null;

/** Configured providers, primary first. Rebuilt only if the env changes (tests, hot reload). */
export function providerChain(): LlmProvider[] {
  const primary = config.llm.primary();
  const fallbacks = config.llm.fallbacks();
  const key = JSON.stringify([primary, fallbacks, ORDER.map((id) => [config.llm[id].apiKey().length, config.llm[id].model()])]);
  if (cached?.key === key) return cached.chain;

  const ids: ProviderId[] = [];
  const add = (id: ProviderId) => !ids.includes(id) && ids.push(id);
  if (primary) add(primary);
  for (const id of fallbacks ?? ORDER) add(id);

  const chain = ids.map(build).filter((p): p is LlmProvider => p !== null);
  if (!chain.length) {
    throw new LlmError(
      "No AI provider configured. Set GEMINI_API_KEY (free), GROQ_API_KEY (free) or ANTHROPIC_API_KEY in backend/.env.",
      primary ?? "gemini",
      "auth",
    );
  }
  cached = { key, chain };
  return chain;
}

export function describeProviders() {
  try {
    return providerChain().map((p) => ({ id: p.id, label: p.label, model: p.model }));
  } catch {
    return [];
  }
}

async function withFallback<T>(fn: (p: LlmProvider) => Promise<T>, prefer?: ProviderId): Promise<{ value: T; provider: LlmProvider }> {
  const chain = providerChain();
  const ordered = prefer ? [...chain.filter((p) => p.id === prefer), ...chain.filter((p) => p.id !== prefer)] : chain;
  let firstError: unknown = null;
  for (const provider of ordered) {
    try {
      return { value: await fn(provider), provider };
    } catch (err) {
      firstError ??= err;
      // A refusal is an answer, not an outage: don't shop it around to other models.
      if (err instanceof LlmError && err.kind === "refusal") throw err;
      console.warn(`[llm] ${provider.label} (${provider.model}) failed: ${err instanceof Error ? err.message : err}. Trying next provider.`);
    }
  }
  throw firstError;
}

/** One agent step. `prefer` keeps a turn on the provider that started it, when it's healthy. */
export function chat(req: ChatRequest, prefer?: ProviderId): Promise<{ value: ChatOutput; provider: LlmProvider }> {
  return withFallback((p) => p.chat(req), prefer);
}

/** Structured JSON output validated against a Zod schema. */
export async function json<T>(req: JsonRequest<T>): Promise<{ value: T; provider: LlmProvider }> {
  return withFallback((p) => p.json(req));
}
