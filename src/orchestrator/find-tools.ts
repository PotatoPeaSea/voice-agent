import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { McpTools } from "../lookup/mcp.js";
import { parseArgs, type ToolSet } from "./toolset.js";

/**
 * Tool search for the voice model. Servers marked `core: false` in config/mcp.yaml keep their tools out of
 * the prompt (every definition is sent on every turn); the model finds them with find_tools, which switches
 * the matches on for the next calls. Offered only while some tools are held back.
 */
export class FindTools implements ToolSet {
  constructor(private readonly mcp: McpTools) {}

  get definitions(): ChatCompletionTool[] {
    const hidden = this.mcp.deferredServers;
    if (!hidden.size) return [];
    const servers = [...hidden].map(([name, n]) => `${name} (${n})`).join(", ");
    return [
      {
        type: "function",
        function: {
          name: "find_tools",
          description:
            `Look up more tools you don't have loaded yet, from: ${servers}. Describe what you need ("search the user's email", "calendar events"); ` +
            "the matching tools become available to call right away. For a question that needs several lookups, quick_agent already has all of them.",
          parameters: { type: "object", properties: { query: { type: "string", description: "What you want to do, in a few words." } }, required: ["query"] },
        },
      },
    ];
  }

  handles(name: string): boolean {
    return name === "find_tools";
  }

  execute(_name: string, rawArgs: string): unknown {
    const args = parseArgs(rawArgs);
    if (typeof args === "string") return { error: args };
    const query = typeof args.query === "string" ? args.query : "";
    const found = this.mcp.search(query);
    if (!found.length) return { found: [], note: "No matching tools. Try other words, or use quick_agent." };
    this.mcp.activate(found.map((f) => f.name));
    return {
      found: found.map((f) => ({ name: f.name, description: f.def.type === "function" ? f.def.function.description : "" })),
      note: "These tools are now available; call them directly.",
    };
  }
}
