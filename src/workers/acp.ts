import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { TaskRegistry } from "../tasks/registry.js";
import { parseReport, REPORT_INSTRUCTIONS } from "../tasks/report.js";
import type { Task, TaskSettings } from "../tasks/types.js";
import type { WorkerAdapter, WorkerSetting } from "./types.js";

/** What newSession / resumeSession return that workers care about (Hermes adds `models`). */
export type SessionInfo = Pick<acp.NewSessionResponse, "configOptions" | "modes"> & { models?: ModelState | null };

export interface ModelState {
  currentModelId: string;
  availableModels: { modelId: string; name: string; description?: string | null }[];
}

export interface SessionState {
  task: Task;
  sessionId: string;
  busy: boolean;
  queue: string[];
  permission?: (outcome: acp.RequestPermissionResponse) => void;
  info: SessionInfo;
}

export interface AcpWorkerOptions {
  defaults?: TaskSettings;
  /** Models agents may never use (substrings of the model id or name, case-insensitive). */
  blockedModels?: string[];
}

/**
 * A coding agent spoken to over the Agent Client Protocol. One agent process
 * hosts every session. The agent runs its own tools (shell, file edits); we
 * observe them through session updates and answer its permission requests.
 * Subclasses say how to launch the agent and how its settings map onto ACP.
 */
export abstract class AcpWorker implements WorkerAdapter {
  abstract readonly name: string;
  private child?: ChildProcess;
  protected connection?: acp.ClientSideConnection;
  private ready?: Promise<acp.ClientSideConnection>;
  private readonly sessions = new Map<string, SessionState>(); // by ACP session id
  private readonly byTask = new Map<string, SessionState>();
  private readonly resuming = new Map<string, Promise<SessionState>>();
  /** Settings info from the most recent session, for settings() without opening one. */
  protected lastInfo?: SessionInfo;
  private stopping = false;

  protected readonly defaults: TaskSettings;
  private readonly blockedModels: string[];

  constructor(
    protected readonly registry: TaskRegistry,
    protected readonly log: (...a: unknown[]) => void,
    options: AcpWorkerOptions = {},
  ) {
    this.defaults = options.defaults ?? {};
    this.blockedModels = (options.blockedModels ?? []).map((m) => m.toLowerCase());
  }

  /** The command that starts the agent speaking ACP on stdio. */
  protected abstract command(): { cmd: string; args: string[] };

  /** Apply settings to a live session; return what's now current and what was skipped. */
  protected abstract applySettings(state: SessionState, settings: TaskSettings): Promise<{ current: TaskSettings; ignored: string[] }>;

  /** Settings the worker supports, read from a session's info. */
  protected abstract describeSettings(info: SessionInfo): WorkerSetting[];

  protected isBlocked(model: string): boolean {
    const id = model.toLowerCase();
    return this.blockedModels.some((blocked) => id.includes(blocked));
  }

  private connect(): Promise<acp.ClientSideConnection> {
    if (this.ready) return this.ready;
    const { cmd, args } = this.command();
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stderr?.on("data", () => {}); // agent diagnostics; too chatty to log
    const failed = new Promise<never>((_, reject) => {
      child.on("error", (err) => reject(new Error(`couldn't start ${this.name} (${cmd}): ${err.message}`)));
    });
    child.on("exit", (code) => {
      this.log(`${this.name} agent exited (${code})`);
      // On our own shutdown, leave tasks as they were: the saved registry marks them interrupted on the next start.
      if (this.stopping) return;
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
    this.ready = Promise.race([
      failed,
      connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }).then((init) => {
        this.log(`${this.name} ready (${init.agentInfo?.name} ${init.agentInfo?.version})`);
        return connection;
      }),
    ]);
    this.ready.catch(() => (this.ready = undefined));
    return this.ready;
  }

  async start(task: Task, prompt: string): Promise<void> {
    const connection = await this.connect();
    const session = await connection.newSession({ cwd: task.cwd, mcpServers: [] });
    const state = this.register(task, session.sessionId, session);
    this.registry.update(task, { sessionId: session.sessionId });
    this.registry.log(task, `acp session ${session.sessionId}`);

    const { ignored } = await this.configure(task, { ...this.defaults, ...task.settings });
    if (ignored.length) this.registry.update(task, { notes: ignored.map((i) => `ignored ${i}`) });
    this.runTurn(state, prompt);
  }

  async send(task: Task, message: string): Promise<void> {
    const state = await this.state(task);
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
    const state = await this.state(task);
    const { current, ignored } = await this.applySettings(state, settings);
    if (ignored.length) this.registry.log(task, `ignored settings: ${ignored.join(", ")}`);
    this.registry.update(task, { settings: current });
    return { settings: current, ignored };
  }

  answerPermission(task: Task, optionId: string): void {
    const state = this.byTask.get(task.id);
    const pending = task.pendingPermission;
    if (!state?.permission || !pending) throw new Error(`${task.id} has no pending permission request`);
    const option = pending.options.find((o) => o.id === optionId || o.name.toLowerCase() === optionId.toLowerCase());
    if (!option) throw new Error(`Unknown option "${optionId}". Options: ${pending.options.map((o) => o.id).join(", ")}`);
    state.permission({ outcome: { outcome: "selected", optionId: option.id } });
    state.permission = undefined;
    this.registry.update(task, { pendingPermission: undefined, status: "running" });
    this.registry.log(task, `permission answered: ${option.name}`);
  }

  async cancel(task: Task): Promise<void> {
    const state = this.byTask.get(task.id);
    if (state) {
      state.queue = [];
      state.permission?.({ outcome: { outcome: "cancelled" } });
      state.permission = undefined;
      await this.connection?.cancel({ sessionId: state.sessionId });
    }
    // Without a live session (e.g. after a restart) nothing is running; just record it.
    this.registry.update(task, { status: "cancelled", pendingPermission: undefined });
    this.registry.log(task, "cancelled");
  }

  async settings(): Promise<WorkerSetting[]> {
    if (!this.lastInfo) {
      const connection = await this.connect();
      const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
      this.lastInfo = session as SessionInfo;
      await connection.closeSession?.({ sessionId: session.sessionId }).catch(() => {});
    }
    return this.describeSettings(this.lastInfo);
  }

  shutdown(): void {
    this.stopping = true;
    this.child?.kill();
  }

  private register(task: Task, sessionId: string, info: SessionInfo): SessionState {
    const state: SessionState = { task, sessionId, busy: false, queue: [], info };
    this.sessions.set(sessionId, state);
    this.byTask.set(task.id, state);
    this.lastInfo = info;
    return state;
  }

  /** The task's live session, reattaching to it (ACP session/resume) if it's from before a restart. */
  private async state(task: Task): Promise<SessionState> {
    const live = this.byTask.get(task.id);
    if (live) return live;
    if (!task.sessionId) throw new Error(`${task.id} has no ${this.name} session`);
    let pending = this.resuming.get(task.id);
    if (!pending) {
      pending = this.resume(task, task.sessionId).finally(() => this.resuming.delete(task.id));
      this.resuming.set(task.id, pending);
    }
    return pending;
  }

  private async resume(task: Task, sessionId: string): Promise<SessionState> {
    const connection = await this.connect();
    let info: SessionInfo;
    try {
      info = await connection.resumeSession({ sessionId, cwd: task.cwd, mcpServers: [] });
    } catch (err) {
      throw new Error(`Couldn't reattach to ${task.id}'s ${this.name} session: ${acpErrorMessage(err)}`);
    }
    // Registered only after the resume returns, so any history the agent replays isn't mistaken for new output.
    const state = this.register(task, sessionId, info);
    this.registry.log(task, `resumed acp session ${sessionId}`);
    return state;
  }

  private runTurn(state: SessionState, prompt: string): void {
    const { task } = state;
    state.busy = true;
    this.registry.update(task, { status: "running", currentText: "", turns: task.turns + 1, error: undefined });
    this.registry.log(task, `prompt: ${prompt.split("\n")[0]}`);

    this.connection!.prompt({ sessionId: state.sessionId, prompt: [{ type: "text", text: prompt }] })
      .then((response) => this.onTurnEnd(state, response.stopReason))
      .catch((err: Error) => this.fail(state, acpErrorMessage(err)));
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
    if (this.stopping) return; // the in-flight prompt rejects when we kill the agent; not a real failure
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
        state.info.configOptions = update.configOptions;
        break;
      case "current_mode_update":
        if (state.info.modes) state.info.modes.currentModeId = update.currentModeId;
        break;
    }
    this.registry.update(task, {});
  }

  private onPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const state = this.sessions.get(params.sessionId);
    if (!state) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const { task } = state;
    const question = params.toolCall.title ?? `${this.name} wants to use a tool`;
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

/** ACP errors carry the useful part in data.details; the message is often just "Internal error". */
export function acpErrorMessage(err: unknown): string {
  const e = err as { message?: string; data?: { details?: string } };
  return e.data?.details ?? e.message ?? String(err);
}
