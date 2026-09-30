import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ChatMessage, ChatModel } from "../llm/chat.js";
import type { ToolContext } from "./tools.js";
import { errorMessage, parseArgs, type ToolSet } from "./toolset.js";
import { assistantTurn } from "./turn.js";

const MAX_ROUNDS = 8;

export const QUICK_AGENT_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "quick_agent",
    description:
      "Hand a question that needs several lookups (a few web searches, reading several files, checking a repo) to a fast helper " +
      "with your read-only tools. Much faster than dispatch_task, but it can't change anything. Usually 5-30 seconds.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The complete question with every detail it needs from the conversation; the helper can't hear it.",
        },
      },
      required: ["question"],
    },
  },
};

function quickAgentPrompt(roots: string[]): string {
  const now = new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" });
  return `You are a research helper for a voice assistant. Answer the question using your tools, then reply with only the answer: plain text, 2-6 sentences with the specific facts, names and numbers the assistant should say aloud. No markdown, no URLs unless the question asks for them.
- Your tools only read. You can't edit files, run commands or send anything; if the question needs that, say so.
- Call several tools at once when the lookups don't depend on each other.
- Stop as soon as you can answer. You have at most ${MAX_ROUNDS} rounds of tool calls; answer with what you have before then.
- If you couldn't find something, say what you checked.
Project folders are under: ${roots.join(", ")}. It is now ${now}.`;
}

export interface QuickAgentDeps {
  chat: ChatModel;
  /** The read-only lookups it may use (never the task tools or itself). */
  tools: ToolSet;
  roots: string[];
  log: (...a: unknown[]) => void;
}

/**
 * A middle tier between calling a lookup directly and dispatching a full agent:
 * a short tool loop with the front model's own LLM and read-only lookups,
 * run in-process. No agent session, no read-back, and nothing it can break.
 */
export class QuickAgent implements ToolSet {
  readonly definitions = [QUICK_AGENT_TOOL];
  private next = 1;

  constructor(private readonly deps: QuickAgentDeps) {}

  handles(name: string): boolean {
    return name === "quick_agent";
  }

  async execute(_name: string, rawArgs: string, ctx: ToolContext): Promise<unknown> {
    const args = parseArgs(rawArgs);
    if (typeof args === "string") return { error: args };
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (!question) return { error: "question is required" };

    const tag = `quick-agent q${this.next++}:`;
    const { chat, tools, roots, log } = this.deps;
    const history: ChatMessage[] = [{ role: "user", content: question }];
    let answer = "";
    log(tag, question);
    const turn = assistantTurn({
      chat,
      history,
      tools,
      // Its own lookups answer inline: no notify, so nothing inside goes to the background.
      ctx: { userTranscript: ctx.userTranscript, signal: ctx.signal },
      signal: ctx.signal ?? new AbortController().signal,
      log: (...a) => log(tag, ...a),
      onFinal: (text) => (answer = text),
      system: quickAgentPrompt(roots),
      maxRounds: MAX_ROUNDS,
    });
    for await (const _ of turn);
    const lookups = history.filter((m) => m.role === "tool").length;
    if (ctx.signal?.aborted) return { error: `gave up: ${errorMessage(ctx.signal.reason ?? "cancelled")}`, lookups };
    if (!answer) return { error: `no answer after ${MAX_ROUNDS} rounds of lookups`, lookups };
    return { answer, lookups };
  }
}
