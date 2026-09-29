/**
 * `npm run agent:smoke [-- hermes]` — end-to-end check of a worker over ACP,
 * without Discord: dispatch a small read-only task, wait for its report,
 * reconfigure the live session, then restart the worker and resume the session
 * with a follow-up (what happens to tasks after the voice agent restarts).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TaskTools } from "../orchestrator/tools.js";
import { TaskRegistry } from "../tasks/registry.js";
import { describeEvent } from "../tasks/notices.js";
import type { TaskEvent } from "../tasks/types.js";
import { makeWorkers } from "../workers/index.js";
import { loadEnv } from "../config.js";

const which = process.argv[2] ?? "claude-code";
const env = loadEnv();
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);
const dir = mkdtempSync(join(tmpdir(), "agent-smoke-"));
let registry = new TaskRegistry({ dir });
let workers = makeWorkers(env, registry, log);
let tools = new TaskTools(registry, workers, [dirname(process.cwd())]);
const ctx = { userTranscript: "count the typescript files in the voice agent project" };

const nextEvent = () => new Promise<TaskEvent>((resolve) => registry.once("event", resolve));

async function settle(taskId: string): Promise<TaskEvent> {
  let event = await nextEvent();
  while (event.type === "needs_input") {
    log("permission requested:", describeEvent(event));
    const allow = event.task.pendingPermission!.options.find((o) => o.kind.startsWith("allow"))!;
    log("auto-answering for the smoke test:", allow.id);
    await tools.execute("answer_permission", JSON.stringify({ task_id: taskId, option_id: allow.id }), ctx);
    event = await nextEvent();
  }
  return event;
}

const t0 = Date.now();
const settings = which === "hermes" ? {} : { model: "sonnet", effort: "low" };
const dispatched = await tools.execute(
  "dispatch_task",
  JSON.stringify({
    worker: which,
    title: "Smoke test",
    goal: "Count the TypeScript files under src/ in this project and name the three largest. Do not modify anything.",
    project: "Voice Agent",
    ...settings,
  }),
  ctx,
);
log("dispatch ->", JSON.stringify(dispatched));
const taskId = (dispatched as { task_id?: string }).task_id;
if (!taskId) process.exit(1);

let event = await settle(taskId);
log(`${event.type} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
log("spoken update ->", describeEvent(event));
log("status ->", JSON.stringify(await tools.execute("get_task", JSON.stringify({ task_id: taskId }), ctx)).slice(0, 600));
const reconfigure = which === "hermes" ? { mode: "accept_edits" } : { model: "opus", effort: "medium" };
log("configure ->", JSON.stringify(await tools.execute("configure_task", JSON.stringify({ task_id: taskId, ...reconfigure }), ctx)));
log("agent_options ->", JSON.stringify(await tools.execute("agent_options", JSON.stringify({ worker: which }), ctx)).slice(0, 300));
if (event.type !== "finished") process.exit(1);

// Simulate a restart: new registry loaded from disk, new agent processes, then resume with a follow-up.
registry.save();
for (const worker of workers) worker.shutdown();
registry = new TaskRegistry({ dir });
workers = makeWorkers(env, registry, log);
tools = new TaskTools(registry, workers, [dirname(process.cwd())]);
log("after restart ->", JSON.stringify(await tools.execute("list_tasks", "{}", ctx)));
log("follow-up ->", JSON.stringify(await tools.execute("send_to_task", JSON.stringify({ task_id: taskId, message: "Which of those three files did you name first?" }), ctx)));
event = await settle(taskId);
log(`after resume: ${event.type} ->`, describeEvent(event));

for (const worker of workers) worker.shutdown();
process.exit(event.type === "finished" ? 0 : 1);
