import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { MemoryClient } from "../memory/client.js";
import { errorMessage, parseArgs, toolName, truncate, type ToolSet } from "./toolset.js";

export const MEMORY_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "memory_search",
      description:
        "Search the shared long-term memory (facts and past conversations with the user, from this assistant and the user's other agents). " +
        'Use when the user asks what they said or decided before, refers to something earlier ("like last time", "what did I tell you about..."), ' +
        "or when a stored preference or project fact would change your answer. Use a few keywords, not a sentence. If nothing is found, say so; don't guess.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Keywords to look for." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_remember",
      description:
        'Save something to the shared long-term memory when the user asks you to remember it ("remember that I prefer..."). ' +
        "Write it as one clear, self-contained statement. Don't use it for passwords or other secrets.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "What to remember, as a complete statement." } },
        required: ["text"],
      },
    },
  },
];

const NAMES = new Set(MEMORY_TOOL_DEFINITIONS.map(toolName));
const MAX_HIT_CHARS = 400;

/** The voice model's window onto the shared memory service. */
export class MemoryTools implements ToolSet {
  readonly definitions = MEMORY_TOOL_DEFINITIONS;

  constructor(private readonly memory: MemoryClient) {}

  handles(name: string): boolean {
    return NAMES.has(name);
  }

  async execute(name: string, rawArgs: string): Promise<unknown> {
    const args = parseArgs(rawArgs);
    if (typeof args === "string") return { error: args };
    const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
    try {
      switch (name) {
        case "memory_search": {
          const query = str("query");
          if (!query) return { error: "give some keywords to search for" };
          const hits = await this.memory.search(query, 5);
          if (!hits.length) return { query, results: [], note: "Nothing about that in memory." };
          return {
            query,
            results: hits.map((h) => ({
              from: h.kind === "fact" ? "remembered fact" : `earlier conversation${h.role ? ` (${h.role})` : ""}`,
              text: truncate(h.text, MAX_HIT_CHARS),
              ...(h.when ? { when: h.when } : {}),
            })),
          };
        }
        case "memory_remember": {
          const text = str("text");
          if (!text) return { error: "say what to remember" };
          this.memory.capture("notes", [{ role: "user", content: `Remember this: ${text}` }]);
          return { ok: true, saved: text };
        }
        default:
          return { error: `unknown tool ${name}` };
      }
    } catch (err) {
      return { error: `Memory isn't reachable right now (${errorMessage(err)}). Tell the user and carry on without it.` };
    }
  }
}
