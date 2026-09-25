/**
 * `npm run chat` — talk to the orchestrator by keyboard instead of voice.
 * Same model, prompt, tools and Claude Code workers as the voice bot; task
 * updates are printed and answered just like they'd be spoken.
 *
 * Scripted: `npm run chat -- "first message" "second message"` sends each message,
 * waiting for any dispatched tasks to report back before the next one, then exits.
 */
import { dirname, resolve } from "node:path";
import readline from "node:readline/promises";
import { loadEnv } from "../config.js";
import { ChatModel, type ChatMessage } from "../llm/chat.js";
import { assistantTurn } from "../orchestrator/turn.js";
import { TOOL_DEFINITIONS, TaskTools } from "../orchestrator/tools.js";
import { TaskRegistry } from "../tasks/registry.js";
import { describeEvent } from "../tasks/notices.js";
import type { TaskEvent } from "../tasks/types.js";
import { ClaudeAcpWorker } from "../workers/claude-acp.js";

const env = loadEnv();
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const log = (...a: unknown[]) => console.log(dim(a.map(String).join(" ")));

const roots = (env.WORKER_ROOTS?.split(",") ?? [dirname(process.cwd())]).map((r) => resolve(r.trim()));
const registry = new TaskRegistry();
const worker = new ClaudeAcpWorker(registry, log, {
  defaults: { model: env.CLAUDE_MODEL, effort: env.CLAUDE_EFFORT, mode: env.CLAUDE_MODE },
  blockedModels: env.CLAUDE_BLOCKED_MODELS,
});
const taskTools = new TaskTools(registry, worker, roots);
const tools = { definitions: TOOL_DEFINITIONS, execute: taskTools.execute.bind(taskTools) };
const chat = new ChatModel(env);
const history: ChatMessage[] = [];
const events: TaskEvent[] = [];
let wake: (() => void) | undefined;
registry.on("event", (event) => {
  events.push(event);
  wake?.();
});

async function turn(content: string, transcript: string): Promise<void> {
  history.push({ role: "user", content });
  process.stdout.write("\x1b[36mbot:\x1b[0m ");
  let final = "";
  const tokens = assistantTurn({
    chat,
    history,
    tools,
    ctx: { userTranscript: transcript },
    signal: new AbortController().signal,
    log: (...a) => console.log(`\n${dim(a.map(String).join(" "))}`),
    onFinal: (text) => (final = text),
  });
  for await (const token of tokens) process.stdout.write(token);
  process.stdout.write("\n");
  if (final) history.push({ role: "assistant", content: final });
}

async function deliverEvents(): Promise<void> {
  while (events.length) {
    const event = events.shift()!;
    const text = describeEvent(event);
    console.log(dim(`[task update] ${text.split("\n")[0]}`));
    await turn(`[Automatic update, not spoken by the user]\n${text}`, "");
  }
}

const busy = () => registry.list().some((t) => t.status === "starting" || t.status === "running");

const scripted = process.argv.slice(2);
if (scripted.length) {
  for (const message of scripted) {
    console.log(`\x1b[33myou:\x1b[0m ${message}`);
    await turn(message, message);
    // Let dispatched tasks report back (including permission requests) before the next message.
    while (busy() || events.length) {
      if (!events.length) await new Promise<void>((r) => (wake = r));
      await deliverEvents();
      if (registry.list().some((t) => t.status === "needs_input")) break; // next scripted message answers it
    }
  }
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(dim(`agent roots: ${roots.join(", ")} — type a message, or Ctrl+C to quit`));
  registry.on("event", () => void deliverEvents());
  for (;;) {
    const line = (await rl.question("\x1b[33myou:\x1b[0m ")).trim();
    if (line) await turn(line, line);
  }
}
worker.shutdown();
process.exit(0);
