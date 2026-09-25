import type { TaskEvent } from "./types.js";

/** Turn a task event into the short update the front model will summarize aloud. */
export function describeEvent(event: TaskEvent): string {
  const { task } = event;
  const name = `Task ${task.id} "${task.title}"`;
  switch (event.type) {
    case "finished": {
      const report = task.report;
      const bullets = report?.bullets.length ? `\nDetails:\n${report.bullets.map((b) => `- ${b}`).join("\n")}` : "";
      return `${name} finished its turn. Summary: ${report?.headline ?? "no summary"}${bullets}`;
    }
    case "failed":
      return `${name} failed: ${task.error ?? "unknown error"}.`;
    case "needs_input": {
      const pending = task.pendingPermission;
      const options = pending?.options.map((o) => `${o.id} (${o.name})`).join(", ") ?? "";
      return `${name} is waiting for permission: ${pending?.question ?? "unknown action"}. Options: ${options}.`;
    }
  }
}
