import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { Env } from "../config.js";

export type ChatMessage = ChatCompletionMessageParam;

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatEvent = { type: "text"; text: string } | { type: "tool_calls"; calls: ToolCall[] };

/**
 * Streaming chat against any OpenAI-compatible endpoint (DeepSeek by default).
 * Swap providers by changing LLM_BASE_URL / LLM_MODEL / LLM_API_KEY.
 */
export class ChatModel {
  private readonly client: OpenAI;

  constructor(private readonly env: Env) {
    if (!env.LLM_API_KEY) throw new Error("LLM_API_KEY is missing in .env");
    this.client = new OpenAI({ apiKey: env.LLM_API_KEY, baseURL: env.LLM_BASE_URL });
  }

  /** Yields text deltas as they arrive. Aborting the signal cancels the HTTP stream. */
  async *stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string> {
    for await (const event of this.streamWithTools(messages, [], signal)) {
      if (event.type === "text") yield event.text;
    }
  }

  /**
   * Streams text deltas, then (if the model called tools) one tool_calls event
   * with the fully assembled calls.
   */
  async *streamWithTools(messages: ChatMessage[], tools: ChatCompletionTool[], signal: AbortSignal): AsyncIterable<ChatEvent> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.env.LLM_MODEL,
        messages,
        stream: true,
        max_tokens: 800,
        temperature: 0.7,
        ...(tools.length ? { tools } : {}),
        // DeepSeek extension; other providers ignore unknown fields.
        ...({ thinking: { type: this.env.LLM_THINKING ? "enabled" : "disabled" } } as object),
      },
      { signal },
    );
    const calls: ToolCall[] = [];
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) yield { type: "text", text: delta.content };
      for (const part of delta?.tool_calls ?? []) {
        const call = (calls[part.index] ??= { id: "", name: "", arguments: "" });
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.arguments += part.function.arguments;
      }
    }
    const complete = calls.filter(Boolean);
    if (complete.length) yield { type: "tool_calls", calls: complete };
  }
}
