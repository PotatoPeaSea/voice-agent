import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolContext } from "./tools.js";

/** A group of tools the front model can call (task tools, music, lookups, MCP servers...). */
export interface ToolSet {
  readonly definitions: ChatCompletionTool[];
  handles(name: string): boolean;
  execute(name: string, args: string, ctx: ToolContext): unknown;
}

/**
 * Several tool sets as one. Definitions are read live, so a set can gain tools
 * later (an MCP server that finishes connecting after startup).
 */
export function combineTools(...sets: ToolSet[]): ToolSet & { execute(name: string, args: string, ctx: ToolContext): Promise<unknown> } {
  return {
    get definitions() {
      return sets.flatMap((set) => set.definitions);
    },
    handles: (name) => sets.some((set) => set.handles(name)),
    execute: async (name, args, ctx) => {
      const set = sets.find((s) => s.handles(name));
      return set ? set.execute(name, args, ctx) : { error: `unknown tool ${name}` };
    },
  };
}

export function toolName(tool: ChatCompletionTool): string {
  return tool.type === "function" ? tool.function.name : "";
}

/** Parse a tool call's JSON arguments; a string is the error to return to the model. */
export function parseArgs(raw: string): Record<string, unknown> | string {
  try {
    const args: unknown = raw.trim() ? JSON.parse(raw) : {};
    return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : `arguments must be an object: ${raw}`;
  } catch {
    return `arguments were not valid JSON: ${raw}`;
  }
}

/** Cut long text for the model, saying how much was left out. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[... ${text.length - max} more characters cut]`;
}

export function errorMessage(err: unknown): string {
  // ACP and MCP errors put the useful part in data.details ("Internal error" otherwise).
  const e = err as { message?: string; data?: { details?: string } };
  return e?.data?.details ?? e?.message ?? String(err);
}
