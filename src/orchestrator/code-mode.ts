import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { runScript, type ScriptLimits } from "../sandbox/script.js";
import type { ToolContext } from "./tools.js";
import { parseArgs, toolName, type ToolSet } from "./toolset.js";

export const RUN_SCRIPT_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_script",
    description:
      "Run a short JavaScript script that calls several of your lookup tools at once (loops, filters, joins) and returns only what you need, " +
      "instead of one tool call per step. Best when a question needs 3 or more lookups or a loop over results.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "The body of an async function. Call tools as `await tools.<tool_name>({...args})` (each returns the tool's result object and throws if it fails); " +
            "use Promise.all for independent calls. `return` the small value you want back (an object or string), and keep bulky results out of it. " +
            "No filesystem, network or imports: only the tools.",
        },
      },
      required: ["code"],
    },
  },
};

/** Tools that take action are described to the model that way; scripts only get the read-only ones. */
function isReadOnly(tool: ChatCompletionTool): boolean {
  return tool.type === "function" && !tool.function.description?.startsWith("(Takes action");
}

/** `name({a, b?})` plus the first sentence of the description, for listing in the helper's prompt. */
function signature(tool: ChatCompletionTool): string {
  if (tool.type !== "function") return "";
  const props = (tool.function.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined) ?? {};
  const required = new Set(props.required ?? []);
  const args = Object.keys(props.properties ?? {}).map((k) => (required.has(k) ? k : `${k}?`));
  const summary = (tool.function.description ?? "").split(/(?<=[.!?])\s/)[0]?.slice(0, 140) ?? "";
  return `- tools.${tool.function.name}({${args.join(", ")}}): ${summary}`;
}

/**
 * Code mode: one `run_script` tool that runs a model-written script in a WASM sandbox
 * (src/sandbox/script.ts). The script can only call the read-only tools of `inner`; the
 * script's return value is all that comes back, so bulky intermediate results never
 * reach the model's context.
 */
export class CodeModeTools implements ToolSet {
  readonly definitions = [RUN_SCRIPT_TOOL];

  constructor(
    private readonly inner: ToolSet,
    private readonly log: (...a: unknown[]) => void,
    private readonly limits: Partial<ScriptLimits> = {},
  ) {}

  handles(name: string): boolean {
    return name === "run_script";
  }

  /** The tools a script can call. Read live: MCP servers may connect after startup. */
  get scriptTools(): ChatCompletionTool[] {
    return this.inner.definitions.filter(isReadOnly);
  }

  /** A prompt section listing the script API, or "" when there is nothing to call. */
  describeApi(): string {
    const tools = this.scriptTools;
    if (!tools.length) return "";
    return `run_script runs JavaScript (async function body) in a sandbox. Inside it:\n${tools.map(signature).join("\n")}\n` +
      "Each call returns the tool's result object and throws if the tool fails. Use Promise.all for independent calls, loops and filters for the rest, " +
      "and `return` only the facts you need.";
  }

  async execute(_name: string, rawArgs: string, ctx: ToolContext): Promise<unknown> {
    const args = parseArgs(rawArgs);
    if (typeof args === "string") return { error: args };
    const code = typeof args.code === "string" ? args.code : "";
    if (!code.trim()) return { error: "code is required" };
    const allowed = new Set(this.scriptTools.map(toolName));
    const result = await runScript(
      code,
      async (name, callArgs) => {
        if (!allowed.has(name)) return { error: `no tool named ${name}; available: ${[...allowed].join(", ")}` };
        return this.inner.execute(name, JSON.stringify(callArgs), ctx);
      },
      this.limits,
      ctx.signal,
    );
    this.log(`run_script: ${result.toolCalls} tool call(s)${result.error ? `, error: ${result.error}` : ""}`);
    if (result.error) return { error: result.error, ...(result.logs ? { logs: result.logs } : {}), tool_calls: result.toolCalls };
    return { ...(result.output === undefined ? { note: "the script returned nothing; `return` a value" } : { output: result.output }), ...(result.logs ? { logs: result.logs } : {}), tool_calls: result.toolCalls };
  }
}
