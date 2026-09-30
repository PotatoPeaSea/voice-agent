import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { TaskRegistry } from "../tasks/registry.js";
import { buildBrief } from "../tasks/report.js";
import type { Task, TaskSettings } from "../tasks/types.js";
import type { WorkerAdapter } from "../workers/types.js";
import {
  activeSystemPromptName,
  isSystemPromptName,
  setActiveSystemPrompt,
  SYSTEM_PROMPT_DESCRIPTIONS,
  SYSTEM_PROMPT_NAMES,
} from "./prompt.js";
import { toolName } from "./toolset.js";

/** Context from the current voice turn, passed to every tool call. */
export interface ToolContext {
  /** The user's latest utterance, verbatim. */
  userTranscript: string;
  /** Tell the user something later (queued like a task update); lets slow lookups finish in the background. */
  notify?: (text: string) => void;
  /** Aborted when the tool call should give up (a background lookup timing out). */
  signal?: AbortSignal;
}

const settingProps = {
  model: {
    type: "string",
    description:
      "Claude Code: sonnet or opus (fable only if the user asks). Hermes: a model name from agent_options, only if the user names one. Omit to use the default.",
  },
  effort: { type: "string", description: "Claude Code only. Reasoning effort: low, medium, high, xhigh, max." },
  mode: {
    type: "string",
    description:
      "Permission mode. Claude Code: default (asks before changes), acceptEdits, plan (plan first), auto, bypassPermissions. Hermes: default, accept_edits, dont_ask.",
  },
  fast: { type: "string", enum: ["on", "off"], description: "Claude Code only. Fast mode." },
} as const;

/** Workers the front model can pick from. */
const WORKER_NAMES = ["claude-code", "hermes"];
const DEFAULT_WORKER = "claude-code";

export const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_projects",
      description: "List project folders the coding agent is allowed to work in.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "agent_options",
      description: "List an agent's available models, effort levels and permission modes.",
      parameters: { type: "object", properties: { worker: { type: "string", enum: WORKER_NAMES } } },
    },
  },
  {
    type: "function",
    function: {
      name: "dispatch_task",
      description:
        "Start an agent on a task. It works in the background and you are notified when it finishes or needs permission. Only call after the user confirmed the read-back.",
      parameters: {
        type: "object",
        properties: {
          worker: {
            type: "string",
            enum: WORKER_NAMES,
            description:
              "claude-code (default): anything about code or files in a project folder. hermes: Hermes Agent, a general assistant with web browsing, research, messaging and scheduling tools — for work that isn't about a code project, or when the user asks for Hermes; needs no project. The model/effort rules are for claude-code; for hermes leave model unset unless the user names one, and never set effort.",
          },
          title: { type: "string", description: "Short name for the task, 2-5 words." },
          goal: { type: "string", description: "Complete, specific instructions for the agent." },
          project: {
            type: "string",
            description: "Project folder name from list_projects, or an absolute path inside an allowed root. Required for claude-code.",
          },
          done_when: { type: "string", description: "How the agent knows it's finished." },
          constraints: { type: "string", description: "Things the agent must or must not do." },
          ...settingProps,
        },
        required: ["title", "goal"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "List all tasks with their status.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_task",
      description: "Get a task's details. 'status' = progress so far; 'report' = headline + bullets; 'full' = the agent's complete final message.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          detail: { type: "string", enum: ["status", "report", "full"] },
        },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_to_task",
      description: "Send a follow-up instruction, or a slash command like /compact, to an existing task's agent. Queued if it's busy.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" }, message: { type: "string" } },
        required: ["task_id", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "configure_task",
      description: "Change a running task's model, effort, permission mode or fast mode.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" }, ...settingProps },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "answer_permission",
      description: "Answer a task's pending permission request with one of its option ids, as the user decided.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" }, option_id: { type: "string" } },
        required: ["task_id", "option_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_task",
      description: "Stop a task's current work.",
      parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "switch_system_prompt",
      description:
        "Switch your persona (system prompt) when the user asks, e.g. to be chattier or back to normal. " +
        "Takes effect from your next reply, so confirm in the new style. Options: " +
        SYSTEM_PROMPT_NAMES.map((n) => `${n} (${SYSTEM_PROMPT_DESCRIPTIONS[n]})`).join(", "),
      parameters: {
        type: "object",
        properties: { name: { type: "string", enum: SYSTEM_PROMPT_NAMES } },
        required: ["name"],
      },
    },
  },
];

const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(toolName));

/** Executes the front model's tool calls against the task registry and workers. */
export class TaskTools {
  private readonly workers: Map<string, WorkerAdapter>;

  constructor(
    private readonly registry: TaskRegistry,
    workers: WorkerAdapter | WorkerAdapter[],
    private readonly roots: string[],
  ) {
    this.workers = new Map([workers].flat().map((w) => [w.name, w]));
  }

  /** Tool definitions offering only the configured workers (no worker choice at all when there's one). */
  get definitions(): ChatCompletionTool[] {
    const names = [...this.workers.keys()];
    if (names.length > 1) return TOOL_DEFINITIONS;
    return TOOL_DEFINITIONS.map((tool) => {
      if (tool.type !== "function") return tool;
      const params = tool.function.parameters as { properties?: Record<string, unknown> } | undefined;
      if (!params?.properties?.worker) return tool;
      const { worker: _, ...properties } = params.properties;
      return { ...tool, function: { ...tool.function, parameters: { ...params, properties } } };
    });
  }

  handles(name: string): boolean {
    return TOOL_NAMES.has(name);
  }

  /** A worker by name; with no name, Claude Code (or the only worker configured). */
  private worker(name?: string): WorkerAdapter {
    const wanted = name?.trim().toLowerCase();
    const worker = wanted ? this.workers.get(wanted) : (this.workers.get(DEFAULT_WORKER) ?? [...this.workers.values()][0]);
    if (!worker) throw new Error(`No worker "${name}". Available: ${[...this.workers.keys()].join(", ")}`);
    return worker;
  }

  async execute(name: string, rawArgs: string, ctx: ToolContext): Promise<unknown> {
    let args: Record<string, string>;
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return { error: `arguments were not valid JSON: ${rawArgs}` };
    }
    try {
      switch (name) {
        case "list_projects":
          return this.listProjects();
        case "agent_options":
          return await this.worker(args.worker).settings();
        case "dispatch_task":
          return await this.dispatch(args, ctx);
        case "list_tasks":
          return this.registry.list().map((t) => ({ id: t.id, title: t.title, worker: t.worker, status: t.status, project: t.cwd }));
        case "get_task":
          return this.describe(this.task(args.task_id), args.detail ?? "status");
        case "send_to_task": {
          const task = this.task(args.task_id);
          await this.worker(task.worker).send(task, args.message);
          return { ok: true };
        }
        case "configure_task": {
          const task = this.task(args.task_id);
          return await this.worker(task.worker).configure(task, pickSettings(args));
        }
        case "answer_permission": {
          const task = this.task(args.task_id);
          this.worker(task.worker).answerPermission(task, args.option_id);
          return { ok: true };
        }
        case "cancel_task": {
          const task = this.task(args.task_id);
          await this.worker(task.worker).cancel(task);
          return { ok: true };
        }
        case "switch_system_prompt": {
          const wanted = args.name?.trim().toLowerCase() ?? "";
          if (!isSystemPromptName(wanted)) throw new Error(`No system prompt "${args.name}". Available: ${SYSTEM_PROMPT_NAMES.join(", ")}`);
          const previous = activeSystemPromptName();
          setActiveSystemPrompt(wanted);
          return { ok: true, previous, active: wanted };
        }
        default:
          return { error: `unknown tool ${name}` };
      }
    } catch (err) {
      // ACP errors put the useful part in data.details ("Internal error" otherwise).
      const e = err as { message?: string; data?: { details?: string } };
      return { error: e.data?.details ?? e.message ?? String(err) };
    }
  }

  private task(id: string | undefined): Task {
    const task = id ? this.registry.get(id) : undefined;
    if (!task) throw new Error(`No task "${id}". Use list_tasks.`);
    return task;
  }

  private listProjects(): { root: string; projects: string[] }[] {
    return this.roots.map((root) => ({
      root,
      projects: readdirSync(root).filter((name) => !name.startsWith(".") && isDir(join(root, name))),
    }));
  }

  /** Resolve a project name or path, refusing anything outside the allowed roots. */
  resolveProject(project: string): string {
    // A bare folder name: match it against real directory entries so the path keeps its true casing,
    // and ignore case/spaces/dashes since speech recognition mangles them.
    if (!/[\\/]/.test(project)) {
      const wanted = project.toLowerCase().replace(/[\s_-]+/g, "");
      for (const root of this.roots) {
        for (const name of readdirSync(root)) {
          if (name.toLowerCase().replace(/[\s_-]+/g, "") === wanted && isDir(join(root, name))) return join(root, name);
        }
      }
    }
    const candidates = isAbsolute(project) ? [resolve(project)] : this.roots.map((root) => resolve(root, project));
    for (const path of candidates) {
      const inside = this.roots.some((root) => {
        const rel = relative(resolve(root), path);
        return !rel.startsWith("..") && !isAbsolute(rel);
      });
      if (inside && isDir(path)) return path;
    }
    throw new Error(`"${project}" is not a folder inside the allowed roots (${this.roots.join(", ")}). Use list_projects.`);
  }

  private async dispatch(args: Record<string, string>, ctx: ToolContext): Promise<unknown> {
    const worker = this.worker(args.worker);
    if (!args.project && worker.name === DEFAULT_WORKER) throw new Error("project is required for claude-code. Use list_projects.");
    // Hermes work often isn't about a project; it then starts in the first allowed root.
    const cwd = args.project ? this.resolveProject(args.project) : this.roots[0]!;
    const task = this.registry.create({
      title: args.title,
      goal: args.goal,
      cwd,
      worker: worker.name,
      settings: pickSettings(args),
    });
    const prompt = buildBrief({
      goal: args.goal,
      cwd,
      doneWhen: args.done_when,
      constraints: args.constraints,
      userTranscript: ctx.userTranscript,
    });
    try {
      await worker.start(task, prompt);
    } catch (err) {
      this.registry.update(task, { status: "failed", error: (err as Error).message });
      throw err;
    }
    return { task_id: task.id, worker: worker.name, project: cwd, settings: task.settings, ...(task.notes ? { notes: task.notes } : {}) };
  }

  private describe(task: Task, detail: string): unknown {
    const base = { id: task.id, title: task.title, worker: task.worker, status: task.status, project: task.cwd, settings: task.settings };
    if (task.error) Object.assign(base, { error: task.error });
    if (task.pendingPermission) Object.assign(base, { pending_permission: task.pendingPermission });
    if (detail === "full") return { ...base, final_message: task.report?.full ?? task.currentText };
    if (detail === "report") return { ...base, report: task.report ? { headline: task.report.headline, bullets: task.report.bullets } : null };
    return {
      ...base,
      plan: task.plan,
      recent_actions: task.tools.slice(-5).map((t) => `${t.title} (${t.status ?? "pending"})`),
      tool_calls_so_far: task.tools.length,
      running_for_s: Math.round((Date.now() - task.createdAt) / 1000),
    };
  }
}

function pickSettings(args: Record<string, string>): TaskSettings {
  const settings: TaskSettings = {};
  for (const key of ["model", "effort", "mode", "fast"] as const) if (args[key]) settings[key] = args[key];
  return settings;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
