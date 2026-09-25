/**
 * Entry point: live voice conversation in a Discord voice channel.
 * STT (Deepgram Flux) -> LLM (OpenAI-compatible, with tools) -> TTS (voice profile) with barge-in.
 * The LLM can dispatch Claude Code agents (via ACP) that work in the background.
 */
import { Client, Events, GatewayIntentBits, type Guild } from "discord.js";
import { VoiceConnectionStatus, entersState, joinVoiceChannel, type VoiceConnection } from "@discordjs/voice";
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
const worker = new ClaudeAcpWorker(registry, log, {
  defaults: { model: env.CLAUDE_MODEL, effort: env.CLAUDE_EFFORT, mode: env.CLAUDE_MODE },
  blockedModels: env.CLAUDE_BLOCKED_MODELS,
});
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

const JOIN_ATTEMPTS = 6;
const JOIN_TIMEOUT_MS = 20_000;
const JOIN_RETRY_MS = 10_000;
let voiceConnection: VoiceConnection | undefined;

/**
 * Join the voice channel, retrying. After an unclean exit Discord keeps the old
 * voice session for a while and new joins loop between signalling and connecting;
 * tearing down and rejoining after a pause gets through once it expires.
 */
async function joinVoice(guild: Guild): Promise<VoiceConnection> {
  for (let attempt = 1; attempt <= JOIN_ATTEMPTS; attempt++) {
    const connection = joinVoiceChannel({
      guildId: guild.id,
      channelId: env.DISCORD_VOICE_CHANNEL_ID,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      debug: env.VERBOSE,
    });
    voiceConnection = connection;
    connection.on("stateChange", (from, to) => {
      if (from.status !== to.status && env.VERBOSE) log(`voice: ${from.status} -> ${to.status}`);
    });
    if (env.VERBOSE) connection.on("debug", (msg) => log("[voice]", msg.slice(0, 300)));
    connection.on("error", (err) => log("voice connection error:", err.message));
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
      return connection;
    } catch {
      log(`voice join attempt ${attempt}/${JOIN_ATTEMPTS} stuck in "${connection.state.status}"; retrying in ${JOIN_RETRY_MS / 1000}s`);
      connection.destroy();
      await new Promise((r) => setTimeout(r, JOIN_RETRY_MS));
    }
  }
  throw new Error("couldn't join the voice channel; check the channel ID and the bot's Connect/Speak permissions");
}

client.once(Events.ClientReady, async (c) => {
  log(`logged in as ${c.user.tag}`);
  const guild = await c.guilds.fetch(env.DISCORD_GUILD_ID);
  let connection: VoiceConnection;
  try {
    connection = await joinVoice(guild);
  } catch (err) {
    log((err as Error).message);
    return shutdown();
  }
  log("joined voice channel");
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

let shuttingDown = false;
/** Leave the voice channel cleanly so the next start doesn't hit a stale Discord voice session. */
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const session of sessions.values()) session.close();
  worker.shutdown();
  voiceConnection?.destroy(); // sends the voice-state "leave" to Discord
  await new Promise((r) => setTimeout(r, 500)); // let the leave go out before the gateway closes
  await client.destroy();
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(signal, () => void shutdown());

client.login(env.DISCORD_TOKEN);
