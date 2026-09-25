import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { TaskRegistry } from "../tasks/registry.js";
import { parseReport, REPORT_INSTRUCTIONS } from "../tasks/report.js";
import type { Task, TaskSettings } from "../tasks/types.js";
import type { WorkerAdapter, WorkerSetting } from "./types.js";

const require = createRequire(import.meta.url);
const SETTING_IDS = ["model", "effort", "mode", "fast"] as const;

interface SessionState {
  task: Task;
  sessionId: string;
  busy: boolean;
  queue: string[];
  permission?: (outcome: acp.RequestPermissionResponse) => void;
  configOptions: acp.SessionConfigOption[];
}

/**
 * Claude Code as a worker, spoken to over the Agent Client Protocol via
 * @agentclientprotocol/claude-agent-acp. One adapter process hosts every session.
 * Claude Code runs its own tools (shell, file edits); we observe them through
 * session updates and answer its permission requests.
 */
export class ClaudeAcpWorker implements WorkerAdapter {
  readonly name = "claude-code";
  private child?: ChildProcess;
  private connection?: acp.ClientSideConnection;
  private ready?: Promise<acp.ClientSideConnection>;
  private readonly sessions = new Map<string, SessionState>(); // by ACP session id
  private readonly byTask = new Map<string, SessionState>();
  private lastConfigOptions: acp.SessionConfigOption[] = [];

  private readonly defaults: TaskSettings;
  private readonly blockedModels: string[];

  constructor(
    private readonly registry: TaskRegistry,
    private readonly log: (...a: unknown[]) => void,
    options: { defaults?: TaskSettings; blockedModels?: string[] } = {},
  ) {
    this.defaults = options.defaults ?? {};
    this.blockedModels = (options.blockedModels ?? []).map((m) => m.toLowerCase());
  }

  private isBlocked(model: string): boolean {
    const id = model.toLowerCase();
    return this.blockedModels.some((blocked) => id.includes(blocked));
  }

  private connect(): Promise<acp.ClientSideConnection> {
    if (this.ready) return this.ready;
    const adapter = require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
    const child = spawn(process.execPath, [adapter], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stderr?.on("data", () => {}); // adapter diagnostics; too chatty to log
    child.on("exit", (code) => {
      this.log(`claude-code adapter exited (${code})`);
      for (const state of this.sessions.values()) {
        if (state.task.status === "running" || state.task.status === "starting" || state.task.status === "needs_input") {
          this.fail(state, `agent process exited (${code})`);
        }
      }
      this.sessions.clear();
      this.byTask.clear();
      this.ready = undefined;
      this.connection = undefined;
    });

    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    const connection = new acp.ClientSideConnection(
      () => ({
        requestPermission: (params) => this.onPermission(params),
        sessionUpdate: async (params) => this.onUpdate(params),
      }),
      stream,
    );
    this.connection = connection;
    this.ready = connection
      .initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
      .then((init) => {
        this.log(`claude-code ready (${init.agentInfo?.name} ${init.agentInfo?.version})`);
        return connection;
      });
    return this.ready;
  }

  async start(task: Task, prompt: string): Promise<void> {
    const connection = await this.connect();
    const session = await connection.newSession({ cwd: task.cwd, mcpServers: [] });
    const state: SessionState = { task, sessionId: session.sessionId, busy: false, queue: [], configOptions: session.configOptions ?? [] };
    this.sessions.set(session.sessionId, state);
    this.byTask.set(task.id, state);
    this.lastConfigOptions = state.configOptions;
    this.registry.log(task, `acp session ${session.sessionId}`);

    const { ignored } = await this.configure(task, { ...this.defaults, ...task.settings });
    if (ignored.length) this.registry.update(task, { notes: ignored.map((i) => `ignored ${i}`) });
    this.runTurn(state, prompt);
  }

  async send(task: Task, message: string): Promise<void> {
    const state = this.state(task);
    // Slash commands pass through untouched; normal messages get the report format reminder.
    const prompt = message.trim().startsWith("/") ? message : `${message}\n\n${REPORT_INSTRUCTIONS}`;
    if (state.busy) {
      state.queue.push(prompt);
      this.registry.log(task, `queued follow-up: ${message}`);
    } else {
      this.runTurn(state, prompt);
    }
  }

  async configure(task: Task, settings: TaskSettings): Promise<{ settings: TaskSettings; ignored: string[] }> {
    if (settings.model && this.isBlocked(settings.model)) {
      throw new Error(`Model "${settings.model}" is blocked by configuration. Choose another model (see agent_options).`);
    }
    const state = this.state(task);
    const connection = await this.connect();
    const ignored: string[] = [];
    // Model first: it decides which other options exist (Haiku has no effort; fast mode is model-specific).
    for (const id of SETTING_IDS) {
      const value = settings[id];
      if (value === undefined) continue;
      if (!state.configOptions.some((o) => o.id === id)) {
        ignored.push(`${id} (not supported by model ${currentValue(state, "model") ?? "?"})`);
        continue;
      }
      try {
        const response = await connection.setSessionConfigOption({ sessionId: state.sessionId, configId: id, value });
        state.configOptions = response.configOptions;
        this.lastConfigOptions = response.configOptions;
        this.registry.log(task, `set ${id}=${value}`);
      } catch (err) {
        throw new Error(`Couldn't set ${id}=${value}: ${acpErrorMessage(err)}`);
      }
    }
    if (ignored.length) this.registry.log(task, `ignored settings: ${ignored.join(", ")}`);
    const current: TaskSettings = {};
    for (const option of state.configOptions) {
      if ((SETTING_IDS as readonly string[]).includes(option.id)) {
        current[option.id as keyof TaskSettings] = String(option.currentValue);
      }
    }
    this.registry.update(task, { settings: current });
    return { settings: current, ignored };
  }

  answerPermission(task: Task, optionId: string): void {
    const state = this.state(task);
    const pending = task.pendingPermission;
    if (!state.permission || !pending) throw new Error(`${task.id} has no pending permission request`);
    const option = pending.options.find((o) => o.id === optionId || o.name.toLowerCase() === optionId.toLowerCase());
    if (!option) throw new Error(`Unknown option "${optionId}". Options: ${pending.options.map((o) => o.id).join(", ")}`);
    state.permission({ outcome: { outcome: "selected", optionId: option.id } });
    state.permission = undefined;
    this.registry.update(task, { pendingPermission: undefined, status: "running" });
    this.registry.log(task, `permission answered: ${option.name}`);
  }

  async cancel(task: Task): Promise<void> {
    const state = this.state(task);
    state.queue = [];
    state.permission?.({ outcome: { outcome: "cancelled" } });
    state.permission = undefined;
    await this.connection?.cancel({ sessionId: state.sessionId });
    this.registry.update(task, { status: "cancelled", pendingPermission: undefined });
    this.registry.log(task, "cancelled");
  }

  async settings(): Promise<WorkerSetting[]> {
    if (!this.lastConfigOptions.length) {
      const connection = await this.connect();
      const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
      this.lastConfigOptions = session.configOptions ?? [];
      await connection.closeSession?.({ sessionId: session.sessionId }).catch(() => {});
    }
    return this.lastConfigOptions
      .filter((o) => (SETTING_IDS as readonly string[]).includes(o.id) && o.type === "select")
      .map((o) => {
        const select = o as acp.SessionConfigOption & { type: "select"; options: acp.SessionConfigSelectOptions };
        const flat = select.options
          .flatMap((x) => ("options" in x ? x.options : [x]))
          .filter((c) => o.id !== "model" || !(this.isBlocked(c.value) || this.isBlocked(c.name)));
        return {
          id: o.id,
          name: o.name,
          current: String(o.currentValue),
          choices: flat.map((c) => ({ value: c.value, description: c.description ?? undefined })),
        };
      });
  }

  shutdown(): void {
    this.child?.kill();
  }

  private state(task: Task): SessionState {
    const state = this.byTask.get(task.id);
    if (!state) throw new Error(`${task.id} has no live Claude Code session`);
    return state;
  }

  private runTurn(state: SessionState, prompt: string): void {
    const { task } = state;
    state.busy = true;
    this.registry.update(task, { status: "running", currentText: "", turns: task.turns + 1, error: undefined });
    this.registry.log(task, `prompt: ${prompt.split("\n")[0]}`);

    this.connection!.prompt({ sessionId: state.sessionId, prompt: [{ type: "text", text: prompt }] })
      .then((response) => this.onTurnEnd(state, response.stopReason))
      .catch((err: Error) => this.fail(state, err.message));
  }

  private onTurnEnd(state: SessionState, stopReason: acp.StopReason): void {
    const { task } = state;
    state.busy = false;
    this.registry.log(task, `turn ended: ${stopReason}`);
    if (task.status === "cancelled" || stopReason === "cancelled") {
      this.registry.update(task, { status: "cancelled" });
      return;
    }
    const report = parseReport(task.currentText);
    this.registry.saveReport(task, report);
    if (stopReason === "refusal" || stopReason === "max_tokens" || stopReason === "max_turn_requests") {
      this.registry.update(task, { status: "failed", error: `stopped: ${stopReason}` });
      this.registry.notify({ type: "failed", task });
    } else {
      this.registry.update(task, { status: "idle" });
      this.registry.notify({ type: "finished", task });
    }
    const next = state.queue.shift();
    if (next) this.runTurn(state, next);
  }

  private fail(state: SessionState, message: string): void {
    state.busy = false;
    this.registry.update(state.task, { status: "failed", error: message });
    this.registry.log(state.task, `failed: ${message}`);
    this.registry.notify({ type: "failed", task: state.task });
  }

  private onUpdate({ sessionId, update }: acp.SessionNotification): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const { task } = state;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") this.registry.update(task, { currentText: task.currentText + update.content.text });
        break;
      case "tool_call":
        task.tools.push({ id: update.toolCallId, title: update.title, kind: update.kind ?? undefined, status: update.status ?? undefined });
        this.registry.log(task, `tool: ${update.title}`);
        break;
      case "tool_call_update": {
        const tool = task.tools.find((t) => t.id === update.toolCallId);
        if (tool) {
          if (update.title) tool.title = update.title;
          if (update.status) tool.status = update.status;
        }
        break;
      }
      case "plan":
        task.plan = update.entries.map((e) => `[${e.status}] ${e.content}`);
        break;
      case "config_option_update":
        state.configOptions = update.configOptions;
        break;
    }
    this.registry.update(task, {});
  }

  private onPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const state = this.sessions.get(params.sessionId);
    if (!state) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const { task } = state;
    const question = params.toolCall.title ?? "Claude Code wants to use a tool";
    this.registry.update(task, {
      status: "needs_input",
      pendingPermission: {
        question,
        options: params.options.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })),
      },
    });
    this.registry.log(task, `permission requested: ${question}`);
    return new Promise((resolve) => {
      state.permission = resolve;
      this.registry.notify({ type: "needs_input", task });
    });
  }
}

function currentValue(state: SessionState, id: string): string | undefined {
  const option = state.configOptions.find((o) => o.id === id);
  return option ? String(option.currentValue) : undefined;
}

/** ACP errors carry the useful part in data.details; the message is often just "Internal error". */
function acpErrorMessage(err: unknown): string {
  const e = err as { message?: string; data?: { details?: string } };
  return e.data?.details ?? e.message ?? String(err);
}
