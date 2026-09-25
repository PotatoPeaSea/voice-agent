import type { Task, TaskSettings } from "../tasks/types.js";

/** A selectable value for a worker setting (model, effort, mode, ...). */
export interface SettingChoice {
  value: string;
  description?: string;
}

export interface WorkerSetting {
  id: string;
  name: string;
  current: string;
  choices: SettingChoice[];
}

/**
 * A coding agent the voice orchestrator can hand tasks to (Claude Code via ACP
 * now; Hermes later). Implementations update the Task object and emit events
 * through the TaskRegistry.
 */
export interface WorkerAdapter {
  readonly name: string;
  /** Start a new session for the task and send it the prompt. Resolves once the session exists. */
  start(task: Task, prompt: string): Promise<void>;
  /** Send another message (or slash command) to the task's session; queued if it's busy. */
  send(task: Task, message: string): Promise<void>;
  /**
   * Change settings on a live session. Settings the current model doesn't support
   * (e.g. effort on Haiku) are skipped and listed in `ignored`.
   */
  configure(task: Task, settings: TaskSettings): Promise<{ settings: TaskSettings; ignored: string[] }>;
  /** Answer a pending permission request. */
  answerPermission(task: Task, optionId: string): void;
  cancel(task: Task): Promise<void>;
  /** Settings the worker supports and their allowed values. */
  settings(): Promise<WorkerSetting[]>;
  shutdown(): void;
}
