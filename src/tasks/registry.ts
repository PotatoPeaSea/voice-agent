import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task, TaskEvent, TaskReport } from "./types.js";

const DATA_DIR = join(process.cwd(), "data", "tasks");

/**
 * In-memory task list with an on-disk trail: data/tasks/<id>.log (events) and
 * data/tasks/<id>.md (latest full report).
 */
export class TaskRegistry extends EventEmitter<{ event: [TaskEvent] }> {
  private readonly tasks = new Map<string, Task>();
  private counter = 0;

  constructor() {
    super();
    mkdirSync(DATA_DIR, { recursive: true });
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
  }

  log(task: Task, line: string): void {
    appendFileSync(join(DATA_DIR, `${task.id}.log`), `${new Date().toISOString()} ${line}\n`);
  }

  saveReport(task: Task, report: TaskReport): void {
    this.update(task, { report });
    writeFileSync(join(DATA_DIR, `${task.id}.md`), `# ${task.id}: ${task.title}\n\n${report.full}\n`);
  }

  notify(event: TaskEvent): void {
    this.log(event.task, `event ${event.type}`);
    this.emit("event", event);
  }
}
