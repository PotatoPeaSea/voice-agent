/**
 * Entry point: live voice conversation in a Discord voice channel.
 * STT (Deepgram Flux) -> LLM (OpenAI-compatible, with tools) -> TTS (voice profile) with barge-in.
 * The LLM can dispatch Claude Code agents (via ACP) that work in the background.
 */
import { Client, Events, GatewayIntentBits } from "discord.js";
import { VoiceConnectionStatus, entersState, joinVoiceChannel } from "@discordjs/voice";
import { loadEnv } from "./config.js";
import { ChatModel } from "./llm/chat.js";
import { Speaker } from "./bot/speaker.js";
import { makeStt, resolveVoice, speak } from "./speech/index.js";
import { loadVoices } from "./speech/voices.js";
import { dirname, resolve } from "node:path";
import { VoiceSession } from "./orchestrator/session.js";
import { TOOL_DEFINITIONS, TaskTools } from "./orchestrator/tools.js";
import { TaskRegistry } from "./tasks/registry.js";
import { describeEvent } from "./tasks/notices.js";
import { ClaudeAcpWorker } from "./workers/claude-acp.js";

const env = loadEnv();
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...args);

const voices = loadVoices();
const chat = new ChatModel(env);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const sessions = new Map<string, VoiceSession>();
let lastActive: VoiceSession | undefined;

const roots = (env.WORKER_ROOTS?.split(",") ?? [dirname(process.cwd())]).map((r) => resolve(r.trim())).filter(Boolean);
const registry = new TaskRegistry();
const worker = new ClaudeAcpWorker(registry, log, { model: env.CLAUDE_MODEL, effort: env.CLAUDE_EFFORT, mode: env.CLAUDE_MODE });
const taskTools = new TaskTools(registry, worker, roots);
const tools = { definitions: TOOL_DEFINITIONS, execute: taskTools.execute.bind(taskTools) };

registry.on("event", (event) => {
  const text = describeEvent(event);
  log(`task event: ${text.split("\n")[0]}`);
  lastActive?.notify(text);
});

function isAllowed(userId: string): boolean {
  return env.ALLOWED_USER_IDS.length === 0 || env.ALLOWED_USER_IDS.includes(userId);
}

client.once(Events.ClientReady, async (c) => {
  log(`logged in as ${c.user.tag}`);
  const guild = await c.guilds.fetch(env.DISCORD_GUILD_ID);
  const connection = joinVoiceChannel({
    guildId: guild.id,
    channelId: env.DISCORD_VOICE_CHANNEL_ID,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
    debug: env.VERBOSE,
  });
  connection.on("stateChange", (from, to) => {
    if (from.status !== to.status) log(`voice: ${from.status} -> ${to.status}`);
  });
  if (env.VERBOSE) connection.on("debug", (msg) => log("[voice]", msg.slice(0, 300)));
  connection.on("error", (err) => log("voice connection error:", err.message));
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      log("voice disconnected; exiting");
      shutdown();
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch {
    log(`voice connection stuck in "${connection.state.status}" after 30s; check channel ID and Connect/Speak permissions`);
    return shutdown();
  }
  const speaker = new Speaker(connection, log);

  // Pay one-time setup costs before the first reply.
  const { primary, fallback } = resolveVoice(voices, voices.active, env);
  const connectable = primary.tts as { connect?: () => Promise<unknown> };
  await Promise.all([
    speaker.warmUp(),
    connectable.connect?.().catch((e: Error) => log("tts connect failed:", e.message)),
  ]);
  log(
    `voice: ${voices.active} (${primary.tts.name}${fallback ? `, fallback ${fallback.tts.name}` : ""}), ` +
      `llm: ${env.LLM_MODEL}, stt: ${env.STT_PROVIDER}, agent roots: ${roots.join(", ")}`,
  );

  connection.receiver.speaking.on("start", (userId) => {
    if (!isAllowed(userId)) return;
    let session = sessions.get(userId);
    if (!session) {
      session = new VoiceSession({
        connection,
        userId,
        speaker,
        chat,
        makeStt: () => makeStt(env),
        speak: (text, signal) => speak(voices, env, text, signal, log),
        tools,
        log,
        verbose: env.VERBOSE,
      });
      sessions.set(userId, session);
    }
    lastActive = session;
    session.wake();
  });
  log("ready — talk to me in the voice channel");
});

function shutdown(): void {
  for (const session of sessions.values()) session.close();
  worker.shutdown();
  client.destroy();
  process.exit(0);
}
process.on("SIGINT", shutdown);

client.login(env.DISCORD_TOKEN);
