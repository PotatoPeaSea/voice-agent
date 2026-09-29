import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task, TaskEvent, TaskReport } from "./types.js";

const DEFAULT_DIR = join(process.cwd(), "data", "tasks");
const SAVE_DELAY_MS = 500;
/** Statuses that mean a turn was in flight; after a restart that turn is gone. */
const IN_FLIGHT = new Set<Task["status"]>(["starting", "running", "needs_input"]);

interface RegistryEvents {
  /** Something the voice agent should be told about. */
  event: [TaskEvent];
  created: [Task];
  /** Any change to a task (fires often while an agent is writing). */
  update: [Task];
}

/**
 * Task list with an on-disk trail: data/tasks/<id>.log (events),
 * data/tasks/<id>.md (latest full report) and data/tasks/registry.json
 * (every task, reloaded on start so tasks survive a restart).
 */
export class TaskRegistry extends EventEmitter<RegistryEvents> {
  private readonly tasks = new Map<string, Task>();
  private counter = 0;
  private readonly dir: string;
  private saveTimer?: NodeJS.Timeout;

  constructor(options: { dir?: string } = {}) {
    super();
    this.dir = options.dir ?? DEFAULT_DIR;
    mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  private get file(): string {
    return join(this.dir, "registry.json");
  }

  /**
   * Reload tasks saved by a previous run. Mid-turn state (streamed text, a pending
   * permission prompt) died with that process, so tasks that were in flight are
   * marked failed with a clear reason; their sessions can still be resumed with a follow-up.
   */
  private load(): void {
    if (!existsSync(this.file)) return;
    let saved: Task[];
    try {
      saved = JSON.parse(readFileSync(this.file, "utf8")) as Task[];
    } catch (err) {
      console.error(`ignoring unreadable ${this.file}: ${(err as Error).message}`);
      return;
    }
    for (const task of saved) {
      if (IN_FLIGHT.has(task.status)) {
        const resumable = task.sessionId ? " Send it a follow-up to resume where it left off." : "";
        task.status = "failed";
        task.error = `Interrupted by a restart of the voice agent while it was working.${resumable}`;
        this.log(task, "interrupted by restart");
      }
      task.pendingPermission = undefined;
      task.currentText = "";
      this.tasks.set(task.id, task);
      this.counter = Math.max(this.counter, Number(task.id.slice(1)) || 0);
    }
  }

  create(fields: Pick<Task, "title" | "goal" | "cwd" | "worker" | "settings">): Task {
    const now = Date.now();
    const task: Task = {
      ...fields,
      id: `t${++this.counter}`,
      status: "starting",
      createdAt: now,
      updatedAt: now,
      currentText: "",
      tools: [],
      plan: [],
      turns: 0,
    };
    this.tasks.set(task.id, task);
    this.log(task, `created in ${task.cwd}: ${task.goal}`);
    this.save();
    this.emit("created", task);
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id.trim().toLowerCase());
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  update(task: Task, changes: Partial<Task>): void {
    Object.assign(task, changes, { updatedAt: Date.now() });
    this.scheduleSave();
    this.emit("update", task);
  }

  log(task: Task, line: string): void {
    appendFileSync(join(this.dir, `${task.id}.log`), `${new Date().toISOString()} ${line}\n`);
  }

  saveReport(task: Task, report: TaskReport): void {
    this.update(task, { report });
    writeFileSync(join(this.dir, `${task.id}.md`), `# ${task.id}: ${task.title}\n\n${report.full}\n`);
  }

  notify(event: TaskEvent): void {
    this.log(event.task, `event ${event.type}`);
    this.save(); // status changes that get announced are worth writing right away
    this.emit("event", event);
  }

  /** Updates arrive per streamed token; batch them into one write. */
  private scheduleSave(): void {
    this.saveTimer ??= setTimeout(() => this.save(), SAVE_DELAY_MS);
  }

  /** Write registry.json now (atomically, via a temp file). Call on shutdown. */
  save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.list(), null, 1));
    renameSync(tmp, this.file);
  }
}
