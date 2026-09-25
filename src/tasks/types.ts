export type TaskStatus = "starting" | "running" | "needs_input" | "idle" | "failed" | "cancelled";

/** Settings a worker session can be configured with (ids match the ACP config options). */
export interface TaskSettings {
  model?: string;
  effort?: string;
  mode?: string;
  fast?: string;
}

export interface PermissionOption {
  id: string;
  name: string;
  kind: string;
}

export interface PendingPermission {
  question: string;
  options: PermissionOption[];
}

export interface ToolActivity {
  id: string;
  title: string;
  kind?: string;
  status?: string;
}

/** Tiered report: a spoken headline, a few bullets, and the full text on request. */
export interface TaskReport {
  headline: string;
  bullets: string[];
  full: string;
}

export interface Task {
  /** Short id that is easy to say out loud, e.g. "t3". */
  id: string;
  title: string;
  goal: string;
  cwd: string;
  worker: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  settings: TaskSettings;
  /** Text the agent has written in the current turn. */
  currentText: string;
  tools: ToolActivity[];
  plan: string[];
  pendingPermission?: PendingPermission;
  report?: TaskReport;
  error?: string;
  /** Non-fatal remarks, e.g. settings the chosen model doesn't support. */
  notes?: string[];
  turns: number;
}

/** What the voice agent is told about asynchronously. */
export type TaskEvent =
  | { type: "finished"; task: Task }
  | { type: "failed"; task: Task }
  | { type: "needs_input"; task: Task };
