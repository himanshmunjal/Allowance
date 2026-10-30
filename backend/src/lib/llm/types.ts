import type { z } from "zod";

// Provider-neutral LLM interface (DECISION.md D-032). The agent, risk check and rule parser
// only talk to this, so Claude, Gemini and Groq are interchangeable and can back each other up.

export type ProviderId = "anthropic" | "gemini" | "groq";

export type ToolSpec = {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};

export type ToolCall = { id: string; name: string; input: unknown };

export type AssistantItem = {
  role: "assistant";
  text: string;
  toolCalls: ToolCall[];
  provider: ProviderId;
  // The provider's own message, replayed verbatim when the same provider continues the
  // conversation (keeps Claude thinking blocks and Gemini thought signatures intact).
  raw: unknown;
};

export type ToolResult = { callId: string; name: string; content: string; isError?: boolean };

export type ChatItem = { role: "user"; text: string } | AssistantItem | { role: "tool"; results: ToolResult[] };

export type ChatRequest = { system: string; tools: ToolSpec[]; items: ChatItem[] };

export type StopReason = "tool_use" | "end" | "refusal" | "max_tokens";

export type ChatOutput = { item: AssistantItem; stop: StopReason };

export type JsonRequest<T> = { name: string; system: string; user: string; schema: z.ZodType<T> };

export interface LlmProvider {
  id: ProviderId;
  label: string;
  model: string;
  chat(req: ChatRequest): Promise<ChatOutput>;
  json<T>(req: JsonRequest<T>): Promise<T>;
}

export type LlmErrorKind = "rate_limit" | "auth" | "unavailable" | "bad_request" | "invalid_output" | "refusal";

export class LlmError extends Error {
  constructor(
    message: string,
    public provider: ProviderId,
    public kind: LlmErrorKind,
  ) {
    super(message);
  }
}
