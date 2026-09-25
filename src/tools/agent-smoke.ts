/**
 * `npm run agent:smoke` — end-to-end check of the Claude Code worker over ACP,
 * without Discord: dispatch a small read-only task, wait for its report,
 * then reconfigure the live session.
 */
import { dirname } from "node:path";
import { TaskTools } from "../orchestrator/tools.js";
import { TaskRegistry } from "../tasks/registry.js";
import { describeEvent } from "../tasks/notices.js";
import type { TaskEvent } from "../tasks/types.js";
import { ClaudeAcpWorker } from "../workers/claude-acp.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);
const registry = new TaskRegistry();
const worker = new ClaudeAcpWorker(registry, log);
const tools = new TaskTools(registry, worker, [dirname(process.cwd())]);
const ctx = { userTranscript: "count the typescript files in the voice agent project" };

const nextEvent = () => new Promise<TaskEvent>((resolve) => registry.once("event", resolve));

const t0 = Date.now();
const dispatched = await tools.execute(
  "dispatch_task",
  JSON.stringify({
    title: "Smoke test",
    goal: "Count the TypeScript files under src/ in this project and name the three largest. Do not modify anything.",
    project: "Voice Agent",
    model: "haiku",
    effort: "low",
  }),
  ctx,
);
log("dispatch ->", JSON.stringify(dispatched));
const taskId = (dispatched as { task_id?: string }).task_id;
if (!taskId) process.exit(1);

let event = await nextEvent();
while (event.type === "needs_input") {
  log("permission requested:", describeEvent(event));
  const allow = event.task.pendingPermission!.options.find((o) => o.kind.startsWith("allow"))!;
  log("auto-answering for the smoke test:", allow.id);
  await tools.execute("answer_permission", JSON.stringify({ task_id: taskId, option_id: allow.id }), ctx);
  event = await nextEvent();
}
log(`${event.type} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
log("spoken update ->", describeEvent(event));
log("status ->", JSON.stringify(await tools.execute("get_task", JSON.stringify({ task_id: taskId }), ctx)).slice(0, 600));
log("configure ->", JSON.stringify(await tools.execute("configure_task", JSON.stringify({ task_id: taskId, model: "sonnet", effort: "medium" }), ctx)));
log("agent_options ->", JSON.stringify(await tools.execute("agent_options", "{}", ctx)).slice(0, 300));

worker.shutdown();
process.exit(event.type === "finished" ? 0 : 1);
