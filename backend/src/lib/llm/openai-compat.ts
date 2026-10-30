import OpenAI from "openai";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  LlmError,
  type ChatItem,
  type ChatOutput,
  type JsonRequest,
  type LlmProvider,
  type ProviderId,
  type ToolSpec,
} from "./types";

// Gemini and Groq through their OpenAI-compatible endpoints, using the official `openai` SDK
// (DECISION.md D-033).

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type RawToolCall = { id?: string; type?: string; function: { name: string; arguments: string }; [extra: string]: unknown };
type RawAssistant = { content?: string | null; tool_calls?: RawToolCall[]; [extra: string]: unknown };

export type CompatOptions = {
  id: Extract<ProviderId, "gemini" | "groq">;
  label: string;
  apiKey: string;
  baseURL: string;
  model: string;
  /** reasoning_effort to send, or null for models that don't accept the parameter. */
  reasoningEffort: "low" | "medium" | null;
  /** Gemini supports json_schema response formats; Groq models vary, so use json_object there. */
  jsonSchemaFormat: boolean;
};

function toTools(tools: ToolSpec[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      // Some providers reject an empty "properties" object: omit parameters for no-arg tools.
      ...(Object.keys(t.parameters.properties).length ? { parameters: t.parameters } : {}),
    },
  }));
}

function toMessages(system: string, items: ChatItem[], self: ProviderId): Msg[] {
  const out: Msg[] = [{ role: "system", content: system }];
  for (const item of items) {
    if (item.role === "user") {
      out.push({ role: "user", content: item.text });
    } else if (item.role === "tool") {
      for (const r of item.results) {
        out.push({ role: "tool", tool_call_id: r.callId, content: r.isError ? `ERROR: ${r.content}` : r.content });
      }
    } else {
      const raw = item.provider === self ? (item.raw as RawAssistant) : null;
      const toolCalls = item.toolCalls.map((c, i) => ({
        // Replay the provider's own tool call (keeps e.g. Gemini thought signatures), with our id.
        ...(raw?.tool_calls?.[i] ?? {}),
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
      }));
      out.push({
        ...(raw?.extra_content ? { extra_content: raw.extra_content } : {}),
        role: "assistant",
        content: item.text || (toolCalls.length ? null : "…"),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      } as Msg);
    }
  }
  return out;
}

function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __invalid_json: raw };
  }
}

const newCallId = () => `call_${randomBytes(6).toString("hex")}`;

export function openAICompatProvider(opts: CompatOptions): LlmProvider {
  // One quick retry (honours retry-after); after that we fall back to the next provider instead
  // of making the user wait on a free-tier rate limit.
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 1, timeout: 45_000 });
  const effort = opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {};

  function wrap(err: unknown): never {
    if (err instanceof LlmError) throw err;
    if (err instanceof OpenAI.RateLimitError) throw new LlmError(`${opts.label} free-tier rate limit reached`, opts.id, "rate_limit");
    if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
      throw new LlmError(`${opts.label} API key is invalid or lacks access`, opts.id, "auth");
    }
    // Gemini reports a bad key as 400 INVALID_ARGUMENT rather than 401.
    if (err instanceof OpenAI.BadRequestError && /api key/i.test(err.message)) {
      throw new LlmError(`${opts.label} API key is invalid or lacks access`, opts.id, "auth");
    }
    if (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.NotFoundError || err instanceof OpenAI.UnprocessableEntityError) {
      throw new LlmError(`${opts.label} rejected the request: ${err.message}`, opts.id, "bad_request");
    }
    if (err instanceof OpenAI.APIError) throw new LlmError(`${opts.label} unavailable (${err.status ?? "network"})`, opts.id, "unavailable");
    throw new LlmError(`${opts.label} call failed: ${err instanceof Error ? err.message : String(err)}`, opts.id, "unavailable");
  }

  async function completeJson(req: JsonRequest<unknown>, useSchema: boolean, repair?: string) {
    const jsonSchema = z.toJSONSchema(req.schema) as Record<string, unknown>;
    delete jsonSchema.$schema;
    const messages: Msg[] = [
      {
        role: "system",
        content: `${req.system}\n\nRespond with a single JSON object only, matching this JSON schema:\n${JSON.stringify(jsonSchema)}`,
      },
      { role: "user", content: req.user },
    ];
    if (repair) messages.push({ role: "user", content: `Your previous JSON was invalid: ${repair}. Reply again with corrected JSON only.` });
    return client.chat.completions.create({
      model: opts.model,
      messages,
      ...effort,
      response_format: useSchema
        ? { type: "json_schema", json_schema: { name: req.name, schema: jsonSchema, strict: true } }
        : { type: "json_object" },
    });
  }

  return {
    id: opts.id,
    label: opts.label,
    model: opts.model,

    async chat(req): Promise<ChatOutput> {
      try {
        const res = await client.chat.completions.create({
          model: opts.model,
          messages: toMessages(req.system, req.items, opts.id),
          tools: toTools(req.tools),
          tool_choice: "auto",
          ...effort,
        });
        const choice = res.choices[0];
        if (!choice) throw new LlmError(`${opts.label} returned no choices`, opts.id, "invalid_output");
        const message = choice.message as unknown as RawAssistant;
        const toolCalls = (message.tool_calls ?? [])
          .filter((c) => c.function)
          .map((c) => ({ id: c.id || newCallId(), name: c.function.name, input: parseArgs(c.function.arguments) }));
        const stop =
          toolCalls.length ? "tool_use"
          : choice.finish_reason === "length" ? "max_tokens"
          : choice.finish_reason === "content_filter" ? "refusal"
          : "end";
        return {
          item: { role: "assistant", text: (message.content ?? "").trim(), toolCalls, provider: opts.id, raw: message },
          stop,
        };
      } catch (err) {
        wrap(err);
      }
    },

    async json<T>(req: JsonRequest<T>): Promise<T> {
      try {
        let useSchema = opts.jsonSchemaFormat;
        let repair: string | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          let res;
          try {
            res = await completeJson(req as JsonRequest<unknown>, useSchema, repair);
          } catch (err) {
            // Schema not accepted by this model: retry once in plain JSON mode.
            if (useSchema && err instanceof OpenAI.BadRequestError) {
              useSchema = false;
              res = await completeJson(req as JsonRequest<unknown>, false, repair);
            } else throw err;
          }
          const text = res.choices[0]?.message?.content ?? "";
          const parsed = req.schema.safeParse(parseArgs(text.replace(/^```(?:json)?\s*|\s*```$/g, "")));
          if (parsed.success) return parsed.data;
          repair = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        }
        throw new LlmError(`${opts.label} returned JSON that didn't match the schema (${repair})`, opts.id, "invalid_output");
      } catch (err) {
        wrap(err);
      }
    },
  };
}
