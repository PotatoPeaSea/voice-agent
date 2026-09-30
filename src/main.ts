/**
 * Entry point: live voice conversation in a Discord voice channel.
 * STT (Deepgram Flux) -> LLM (OpenAI-compatible, with tools) -> TTS (voice profile) with barge-in.
 * The LLM can dispatch Claude Code and Hermes agents (via ACP) that work in the background;
 * their progress and full reports are mirrored to Discord text.
 *
 * The bot follows allowed users into voice (VOICE_AUTO_JOIN) and can be moved with
 * /join, /leave and /newchat; leaving the call keeps it online and tasks running.
 */
import { Client, Events, GatewayIntentBits, MessageFlags, type ChatInputCommandInteraction, type Guild } from "discord.js";
import { VoiceConnectionStatus, entersState, joinVoiceChannel, type VoiceConnection } from "@discordjs/voice";
import { loadEnv } from "./config.js";
import { ChatModel, type ChatMessage } from "./llm/chat.js";
import { Speaker } from "./bot/speaker.js";
import { makeStt, resolveVoice, speak } from "./speech/index.js";
import { loadVoices } from "./speech/voices.js";
import { dirname, resolve } from "node:path";
import { VoiceSession } from "./orchestrator/session.js";
import { TaskTools } from "./orchestrator/tools.js";
import { TaskRegistry } from "./tasks/registry.js";
import { describeEvent } from "./tasks/notices.js";
import { makeWorkers } from "./workers/index.js";
import { TaskReporter } from "./bot/reports.js";
import { COMMANDS } from "./bot/commands.js";
import { voiceAutocomplete, voiceCommand, type VoiceCommandDeps } from "./bot/voice-command.js";

const env = loadEnv();
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...args);

const voices = loadVoices();
const chat = new ChatModel(env);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
/** Each user's conversation, kept across leaving and rejoining a call (cleared by "new chat"). */
const histories = new Map<string, ChatMessage[]>();

const roots = (env.WORKER_ROOTS?.split(",") ?? [dirname(process.cwd())]).map((r) => resolve(r.trim())).filter(Boolean);
const registry = new TaskRegistry();
const workers = makeWorkers(env, registry, log);
const taskTools = new TaskTools(registry, workers, roots);
const tools = { definitions: taskTools.definitions, execute: taskTools.execute.bind(taskTools) };

/** The current call: one connection and speaker, one VoiceSession per allowed user who has spoken. */
interface Call {
  channelId: string;
  connection: VoiceConnection;
  speaker: Speaker;
  sessions: Map<string, VoiceSession>;
  lastActive?: VoiceSession;
}
let call: Call | undefined;
let guild: Guild;

registry.on("event", (event) => {
  const text = describeEvent(event);
  log(`task event: ${text.split("\n")[0]}`);
  call?.lastActive?.notify(text);
});

function isAllowed(userId: string): boolean {
  return env.ALLOWED_USER_IDS.length === 0 || env.ALLOWED_USER_IDS.includes(userId);
}

const JOIN_ATTEMPTS = 6;
const JOIN_TIMEOUT_MS = 20_000;
const JOIN_RETRY_MS = 10_000;
/** Grace period before leaving a channel nobody is in any more (auto-join mode). */
const EMPTY_LEAVE_MS = 30_000;

/**
 * Join a voice channel, retrying. After an unclean exit Discord keeps the old
 * voice session for a while and new joins loop between signalling and connecting;
 * tearing down and rejoining after a pause gets through once it expires.
 */
async function connectVoice(channelId: string): Promise<VoiceConnection> {
  for (let attempt = 1; attempt <= JOIN_ATTEMPTS; attempt++) {
    const connection = joinVoiceChannel({
      guildId: guild.id,
      channelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      debug: env.VERBOSE,
    });
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

/** Joins and leaves run one at a time. */
let voiceOps: Promise<unknown> = Promise.resolve();
function serialized<T>(op: () => Promise<T>): Promise<T> {
  const result = voiceOps.then(op);
  voiceOps = result.catch(() => {});
  return result;
}

let ttsConnected = false;

function join(channelId: string): Promise<void> {
  return serialized(async () => {
    if (call?.channelId === channelId) return;
    if (call) await leaveNow("moving to another channel");
    const connection = await connectVoice(channelId);
    const speaker = new Speaker(connection, log);
    const current: Call = { channelId, connection, speaker, sessions: new Map() };
    call = current;
    log(`joined voice channel #${guild.channels.cache.get(channelId)?.name ?? channelId}`);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (call !== current) return;
        log("voice disconnected");
        void leave("disconnected");
      }
    });

    // Pay setup costs before the first reply: the Opus encoder per call, the TTS connection once.
    const { primary, fallback } = resolveVoice(voices, voices.active, env);
    const connectable = primary.tts as { connect?: () => Promise<unknown> };
    await Promise.all([
      speaker.warmUp(),
      ttsConnected ? undefined : connectable.connect?.().catch((e: Error) => log("tts connect failed:", e.message)),
    ]);
    if (!ttsConnected) {
      ttsConnected = true;
      log(
        `voice: ${voices.active} (${primary.tts.name}${fallback ? `, fallback ${fallback.tts.name}` : ""}), ` +
          `llm: ${env.LLM_MODEL}, stt: ${env.STT_PROVIDER}, agents: ${workers.map((w) => w.name).join(", ")}, roots: ${roots.join(", ")}`,
      );
    }

    connection.receiver.speaking.on("start", (userId) => {
      if (!isAllowed(userId) || call !== current) return;
      let session = current.sessions.get(userId);
      if (!session) {
        let history = histories.get(userId);
        if (!history) histories.set(userId, (history = []));
        session = new VoiceSession({
          connection,
          userId,
          speaker,
          chat,
          makeStt: () => makeStt(env),
          speak: (text, signal) => speak(voices, env, text, signal, log),
          tools,
          history,
          log,
          verbose: env.VERBOSE,
        });
        current.sessions.set(userId, session);
      }
      current.lastActive = session;
      session.wake();
    });
    log("ready — talk to me in the voice channel");
  });
}

async function leaveNow(reason: string): Promise<void> {
  const current = call;
  if (!current) return;
  call = undefined;
  clearTimeout(emptyTimer);
  emptyTimer = undefined;
  for (const session of current.sessions.values()) session.close();
  current.connection.destroy(); // sends the voice-state "leave" to Discord
  log(`left voice (${reason})`);
}

function leave(reason: string): Promise<void> {
  return serialized(() => leaveNow(reason));
}

function joinAndLog(channelId: string): void {
  join(channelId).catch((err: Error) => log(`couldn't join: ${err.message}`));
}

/** Humans (not bots) in a voice channel. */
function humansIn(channelId: string): string[] {
  return guild.voiceStates.cache.filter((s) => s.channelId === channelId && !s.member?.user.bot).map((s) => s.id);
}

/** A voice channel an allowed user is in, preferring the configured one. */
function channelWithAllowedUser(): string | undefined {
  const channels = guild.voiceStates.cache
    .filter((s) => !!s.channelId && !s.member?.user.bot && isAllowed(s.id))
    .map((s) => s.channelId!);
  return channels.includes(env.DISCORD_VOICE_CHANNEL_ID) ? env.DISCORD_VOICE_CHANNEL_ID : channels[0];
}

let emptyTimer: NodeJS.Timeout | undefined;

/** Auto-join: follow allowed users in; leave once the call empties, then follow anyone still in voice elsewhere. */
client.on(Events.VoiceStateUpdate, (before, after) => {
  if (!env.VOICE_AUTO_JOIN || !guild || after.guild.id !== guild.id || after.member?.user.bot) return;
  if (!call) {
    if (after.channelId && after.channelId !== before.channelId && isAllowed(after.id)) joinAndLog(after.channelId);
    return;
  }
  const channelId = call.channelId;
  if (humansIn(channelId).length) {
    clearTimeout(emptyTimer);
    emptyTimer = undefined;
  } else if (!emptyTimer) {
    log(`voice channel is empty; leaving in ${EMPTY_LEAVE_MS / 1000}s unless someone comes back`);
    emptyTimer = setTimeout(async () => {
      emptyTimer = undefined;
      if (call?.channelId !== channelId || humansIn(channelId).length) return;
      await leave("channel empty");
      const elsewhere = channelWithAllowedUser();
      if (elsewhere) joinAndLog(elsewhere);
    }, EMPTY_LEAVE_MS);
  }
});

const voiceDeps: VoiceCommandDeps = {
  voices,
  env,
  log,
  preview: (text) => {
    const speaker = call?.speaker;
    if (!speaker || speaker.isSpeaking) return;
    async function* line() {
      yield text;
    }
    speaker.play(speak(voices, env, line(), new AbortController().signal, log)).catch(() => {});
  },
};

client.on(Events.InteractionCreate, (interaction) => {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === "voice" && isAllowed(interaction.user.id)) {
      voiceAutocomplete(interaction, voiceDeps).catch((err: Error) => log(`/voice autocomplete failed: ${err.message}`));
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  onCommand(interaction).catch((err: Error) => {
    log(`/${interaction.commandName} failed: ${err.message}`);
    const content = `Failed: ${err.message}`;
    const reply = interaction.deferred || interaction.replied
      ? interaction.editReply(content)
      : interaction.reply({ content, flags: MessageFlags.Ephemeral });
    reply.catch(() => {});
  });
});

async function onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAllowed(interaction.user.id)) {
    await interaction.reply({ content: "You're not on this bot's allowed users list.", flags: MessageFlags.Ephemeral });
    return;
  }
  switch (interaction.commandName) {
    case "join": {
      const target =
        interaction.options.getChannel("channel")?.id ??
        guild.voiceStates.cache.get(interaction.user.id)?.channelId ??
        env.DISCORD_VOICE_CHANNEL_ID;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // joining can take a while
      await join(target);
      await interaction.editReply(`Joined <#${target}>.`);
      break;
    }
    case "leave":
      if (!call) {
        await interaction.reply({ content: "I'm not in a voice channel.", flags: MessageFlags.Ephemeral });
        break;
      }
      await leave(`/leave by ${interaction.user.username}`);
      await interaction.reply({
        content: env.VOICE_AUTO_JOIN
          ? "Left the call. Tasks keep running; I'll join again when you next enter a voice channel (or use /join)."
          : "Left the call. Tasks keep running; use /join to bring me back.",
        flags: MessageFlags.Ephemeral,
      });
      break;
    case "voice":
      await voiceCommand(interaction, voiceDeps);
      break;
    case "newchat": {
      const session = call?.sessions.get(interaction.user.id);
      if (session) session.reset();
      else histories.get(interaction.user.id)?.splice(0);
      log(`conversation reset by /newchat (${interaction.user.username})`);
      await interaction.reply({ content: "Fresh conversation started. Tasks are still running and listed.", flags: MessageFlags.Ephemeral });
      break;
    }
  }
}

client.once(Events.ClientReady, async (c) => {
  log(`logged in as ${c.user.tag}`);
  guild = await c.guilds.fetch(env.DISCORD_GUILD_ID);
  const reporter = new TaskReporter(client, registry, env.DISCORD_REPORTS_CHANNEL_ID ?? env.DISCORD_VOICE_CHANNEL_ID, log);
  await reporter.start().catch((err: Error) => log(`task reports disabled: ${err.message}`));
  const restored = registry.list();
  if (restored.length) log(`restored ${restored.length} task(s) from data/tasks/registry.json`);
  await guild.commands
    .set(COMMANDS)
    .then(() => log(`slash commands: ${COMMANDS.map((c) => `/${c.name}`).join(" ")}`))
    .catch((err: Error) => log(`couldn't register slash commands (the bot needs the applications.commands scope): ${err.message}`));

  if (!env.VOICE_AUTO_JOIN) return joinAndLog(env.DISCORD_VOICE_CHANNEL_ID);
  const channel = channelWithAllowedUser();
  if (channel) joinAndLog(channel);
  else log("waiting for you to join a voice channel (or use /join)");
});

let shuttingDown = false;
/** Leave the voice channel cleanly so the next start doesn't hit a stale Discord voice session. */
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  registry.save();
  for (const worker of workers) worker.shutdown();
  await leaveNow("shutting down");
  await new Promise((r) => setTimeout(r, 500)); // let the leave go out before the gateway closes
  await client.destroy();
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(signal, () => void shutdown());

client.login(env.DISCORD_TOKEN);
