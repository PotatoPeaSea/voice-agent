/**
 * `npm run chat` — talk to the orchestrator by keyboard instead of voice.
 * Same model, prompt, tools and workers (Claude Code, Hermes) as the voice bot; task
 * updates and background lookup results are printed and answered just like they'd be
 * spoken. Songs can be listed (list_songs) but only play in voice.
 *
 * Scripted: `npm run chat -- "first message" "second message"` sends each message,
 * waiting for any dispatched tasks and background lookups to report back before the next one, then exits.
 */
import { dirname, resolve } from "node:path";
import readline from "node:readline/promises";
import { loadEnv } from "../config.js";
import { ChatModel, type ChatMessage } from "../llm/chat.js";
import { assistantTurn } from "../orchestrator/turn.js";
import { setAssistantName } from "../orchestrator/prompt.js";
import { makeToolbox } from "../orchestrator/toolbox.js";
import { MusicTools } from "../orchestrator/music-tools.js";
import { MusicLibrary } from "../audio/music.js";
import { TaskRegistry } from "../tasks/registry.js";
import { describeEvent } from "../tasks/notices.js";
import { makeWorkers } from "../workers/index.js";

const env = loadEnv();
setAssistantName(env.ASSISTANT_NAME);
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const log = (...a: unknown[]) => console.log(dim(a.map(String).join(" ")));

const roots = (env.WORKER_ROOTS?.split(",") ?? [dirname(process.cwd())]).map((r) => resolve(r.trim()));
const registry = new TaskRegistry();
const workers = makeWorkers(env, registry, log);
const chat = new ChatModel(env);
const musicTools = new MusicTools({ library: new MusicLibrary(env.MUSIC_PATH, env.MUSIC_VOLUME, log), jukebox: () => undefined });
const { tools, jobs, mcp } = makeToolbox({ env, chat, registry, workers, roots, music: musicTools, log });
const history: ChatMessage[] = [];
/** Task events and background lookup results, answered like they'd be spoken. */
const notices: string[] = [];
let wake: (() => void) | undefined;
function notify(text: string): void {
  notices.push(text);
  wake?.();
}
registry.on("event", (event) => notify(describeEvent(event)));

async function turn(content: string, transcript: string): Promise<void> {
  history.push({ role: "user", content });
  process.stdout.write("\x1b[36mbot:\x1b[0m ");
  let final = "";
  const tokens = assistantTurn({
    chat,
    history,
    tools,
    ctx: { userTranscript: transcript, notify },
    signal: new AbortController().signal,
    log: (...a) => console.log(`\n${dim(a.map(String).join(" "))}`),
    onFinal: (text) => (final = text),
  });
  for await (const token of tokens) process.stdout.write(token);
  process.stdout.write("\n");
  if (final) history.push({ role: "assistant", content: final });
}

let delivering = false;
async function deliverNotices(): Promise<void> {
  if (delivering) return;
  delivering = true;
  while (notices.length) {
    const text = notices.shift()!;
    console.log(dim(`[update] ${text.split("\n")[0]!.slice(0, 200)}`));
    await turn(`[Automatic update, not spoken by the user]\n${text}`, "");
  }
  delivering = false;
}

const busy = () => jobs.active > 0 || registry.list().some((t) => t.status === "starting" || t.status === "running");

const scripted = process.argv.slice(2);
if (scripted.length) {
  for (const message of scripted) {
    console.log(`\x1b[33myou:\x1b[0m ${message}`);
    await turn(message, message);
    // Let dispatched tasks and background lookups report back (including permission requests) before the next message.
    while (busy() || notices.length) {
      if (!notices.length) await new Promise<void>((r) => (wake = r));
      await deliverNotices();
      if (registry.list().some((t) => t.status === "needs_input")) break; // next scripted message answers it
    }
  }
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(dim(`agent roots: ${roots.join(", ")} — type a message, or Ctrl+C to quit`));
  wake = () => void deliverNotices();
  for (;;) {
    const line = (await rl.question("\x1b[33myou:\x1b[0m ")).trim();
    if (line) await turn(line, line);
  }
}
registry.save();
for (const worker of workers) worker.shutdown();
await mcp.close();
process.exit(0);
