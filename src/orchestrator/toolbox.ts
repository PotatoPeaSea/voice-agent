import type { Env } from "../config.js";
import type { ChatModel } from "../llm/chat.js";
import { Workspace } from "../lookup/files.js";
import { McpTools } from "../lookup/mcp.js";
import type { TaskRegistry } from "../tasks/registry.js";
import type { WorkerAdapter } from "../workers/types.js";
import { BackgroundJobs } from "./background.js";
import { LookupTools } from "./lookup-tools.js";
import { QuickAgent } from "./quick-agent.js";
import { TaskTools } from "./tools.js";
import { combineTools, type ToolSet } from "./toolset.js";

/** A background lookup or quick-agent question is abandoned after this long. */
const JOB_TIMEOUT_MS = 120_000;

export interface ToolboxDeps {
  env: Env;
  chat: ChatModel;
  registry: TaskRegistry;
  workers: WorkerAdapter[];
  roots: string[];
  music: ToolSet;
  log: (...a: unknown[]) => void;
  /** Called when a background lookup finishes, just before its result is queued for the user. */
  onJobFinish?: () => void;
}

/**
 * Every tool the front model gets, in three tiers:
 * - direct lookups (files, git, time, MCP servers such as web search): read-only, answered in the turn;
 * - quick_agent: a short in-process tool loop over the same lookups, for questions needing several;
 * - dispatch_task and friends: full Claude Code / Hermes agents for work that changes things.
 * Lookups that outlast TOOL_WAIT_SECONDS finish in the background; the quick agent always does.
 */
export function makeToolbox(deps: ToolboxDeps) {
  const { env, chat, registry, workers, roots, music, log } = deps;
  const mcp = McpTools.fromFile(env.MCP_CONFIG, log);
  void mcp.connect();
  const lookups = combineTools(new LookupTools(new Workspace(roots)), mcp);
  const quickAgent = new QuickAgent({ chat, tools: lookups, roots, log });
  const jobs = new BackgroundJobs({ waitMs: env.TOOL_WAIT_SECONDS * 1000, timeoutMs: JOB_TIMEOUT_MS, log, onFinish: deps.onJobFinish });
  // The quick agent needs a few LLM rounds, so waiting for it would only be silence: background it at once.
  const tools = combineTools(new TaskTools(registry, workers, roots), music, jobs.wrap(lookups), jobs.wrap(quickAgent, 0));
  return { tools, jobs, mcp };
}
