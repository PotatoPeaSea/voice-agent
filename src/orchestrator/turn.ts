import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ChatMessage, ChatModel } from "../llm/chat.js";
import { activeSystemPrompt } from "./prompt.js";
import type { ToolContext } from "./tools.js";
import { errorMessage } from "./toolset.js";

const MAX_TOOL_ROUNDS = 5;

export interface TurnTools {
  definitions: ChatCompletionTool[];
  /** A result or a promise of one. */
  execute(name: string, args: string, ctx: ToolContext): unknown;
}

export interface TurnOptions {
  chat: ChatModel;
  /** Conversation so far; tool calls and results are appended to it as they happen. */
  history: ChatMessage[];
  tools?: TurnTools;
  ctx: ToolContext;
  signal: AbortSignal;
  log: (...a: unknown[]) => void;
  /** Receives the final text answer (after all tool rounds). */
  onFinal: (text: string) => void;
  /** System prompt; defaults to the active voice prompt (re-read every round). */
  system?: string;
  maxRounds?: number;
}

/**
 * One assistant turn: stream text as it's generated; when the model calls tools,
 * run them, record the results, and ask again, until it answers in plain text.
 * Shared by the voice session and the text chat.
 */
export async function* assistantTurn(opts: TurnOptions): AsyncIterable<string> {
  const { chat, history, tools, ctx, signal, log } = opts;
  for (let round = 0; round < (opts.maxRounds ?? MAX_TOOL_ROUNDS); round++) {
    let text = "";
    let calls: { id: string; name: string; arguments: string }[] = [];
    const messages: ChatMessage[] = [{ role: "system", content: opts.system ?? activeSystemPrompt() }, ...history];
    for await (const event of chat.streamWithTools(messages, tools?.definitions ?? [], signal)) {
      if (event.type === "text") {
        text += event.text;
        yield event.text;
      } else {
        calls = event.calls;
      }
    }
    if (!calls.length) {
      opts.onFinal(text.trim());
      return;
    }
    // An assistant tool_calls message must be followed by a result for every call.
    history.push({
      role: "assistant",
      content: text || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
    });
    // Calls in one round can't depend on each other's results, so run them together.
    const results = await Promise.all(
      calls.map(async (call) => {
        log(`tool ${call.name}(${call.arguments})`);
        let result: unknown;
        try {
          result = await tools!.execute(call.name, call.arguments, ctx);
        } catch (err) {
          result = { error: errorMessage(err) };
        }
        const content = JSON.stringify(result ?? null);
        log(`  ${call.name} -> ${content.slice(0, 300)}`);
        return content;
      }),
    );
    calls.forEach((call, i) => history.push({ role: "tool", tool_call_id: call.id, content: results[i]! }));
    if (text && !/[.!?]\s*$/.test(text)) yield ". "; // close any spoken preamble before the next round
    if (signal.aborted) return;
  }
  opts.onFinal("");
}
