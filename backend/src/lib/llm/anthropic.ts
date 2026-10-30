import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { LlmError, type ChatItem, type ChatOutput, type JsonRequest, type LlmProvider, type ToolSpec } from "./types";

// Claude via the official Anthropic SDK (beta Messages API for refusal fallbacks, D-019).

type Msg = Anthropic.Beta.BetaMessageParam;

// Server-side refusal fallback: a declined request is re-run on a fallback model in the same call.
const fallbackParams: { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: "default" } = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

// Anthropic tool ids must match ^[a-zA-Z0-9_-]+$; ids from other providers may not.
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

function toMessages(items: ChatItem[]): Msg[] {
  return items.map((item): Msg => {
    if (item.role === "user") return { role: "user", content: item.text };
    if (item.role === "tool") {
      return {
        role: "user",
        content: item.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: safeId(r.callId),
          content: r.content,
          is_error: r.isError,
        })),
      };
    }
    if (item.provider === "anthropic") return { role: "assistant", content: item.raw as Anthropic.Beta.BetaContentBlockParam[] };
    // Turn produced by another provider (after a fallback): rebuild it as plain blocks.
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (item.text) content.push({ type: "text", text: item.text });
    for (const c of item.toolCalls) content.push({ type: "tool_use", id: safeId(c.id), name: c.name, input: c.input ?? {} });
    return { role: "assistant", content: content.length ? content : [{ type: "text", text: "…" }] };
  });
}

function toTools(tools: ToolSpec[]): Anthropic.Beta.BetaToolUnion[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

function wrap(err: unknown): never {
  if (err instanceof LlmError) throw err;
  if (err instanceof Anthropic.RateLimitError) throw new LlmError("Claude is rate-limited", "anthropic", "rate_limit");
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    throw new LlmError("Claude API key is invalid (ANTHROPIC_API_KEY)", "anthropic", "auth");
  }
  if (err instanceof Anthropic.BadRequestError) throw new LlmError(`Claude rejected the request: ${err.message}`, "anthropic", "bad_request");
  if (err instanceof Anthropic.APIError) throw new LlmError(`Claude unavailable (${err.status ?? "network"})`, "anthropic", "unavailable");
  throw new LlmError(`Claude call failed: ${err instanceof Error ? err.message : String(err)}`, "anthropic", "unavailable");
}

export function anthropicProvider(apiKey: string, model: string): LlmProvider {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 });

  return {
    id: "anthropic",
    label: "Claude",
    model,

    async chat(req): Promise<ChatOutput> {
      try {
        const res = await client.beta.messages.create({
          ...fallbackParams,
          model,
          max_tokens: 16000,
          output_config: { effort: "medium" },
          cache_control: { type: "ephemeral" },
          system: req.system,
          tools: toTools(req.tools),
          messages: toMessages(req.items),
        });
        const text = res.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        const toolCalls = res.content
          .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input }));
        const stop =
          res.stop_reason === "refusal" ? "refusal"
          : res.stop_reason === "max_tokens" ? "max_tokens"
          : res.stop_reason === "tool_use" ? "tool_use"
          : "end";
        // Keep the full content (thinking blocks included) so the history stays append-only (D-013).
        return { item: { role: "assistant", text, toolCalls, provider: "anthropic", raw: res.content }, stop };
      } catch (err) {
        wrap(err);
      }
    },

    async json<T>(req: JsonRequest<T>): Promise<T> {
      try {
        const res = await client.beta.messages.parse({
          ...fallbackParams,
          model,
          max_tokens: 4000,
          output_config: { effort: "low", format: betaZodOutputFormat(req.schema) },
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        });
        if (res.stop_reason === "refusal") throw new LlmError("Claude declined", "anthropic", "refusal");
        if (!res.parsed_output) throw new LlmError("Claude returned no parseable output", "anthropic", "invalid_output");
        return res.parsed_output as T;
      } catch (err) {
        wrap(err);
      }
    },
  };
}
