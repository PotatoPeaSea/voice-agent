/**
 * Milestone 0 spike: prove live voice receive + playback works under DAVE E2EE.
 *
 * The bot joins the configured voice channel, records each utterance from an
 * allowed user to recordings/*.wav, then echoes it back into the channel.
 * If you hear yourself, receive (decrypt + decode) and send both work.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Client, Events, GatewayIntentBits } from "discord.js";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
} from "@discordjs/voice";
import prism from "prism-media";
import { loadEnv } from "../config.js";
import { pcmDurationMs, pcmToWav } from "../audio/wav.js";

const env = loadEnv();
const RECORDINGS_DIR = join(process.cwd(), "recordings");
mkdirSync(RECORDINGS_DIR, { recursive: true });

const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...args);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
player.on("error", (err) => log("player error:", err.message));

const activeUsers = new Set<string>();

function isAllowed(userId: string): boolean {
  return env.ALLOWED_USER_IDS.length === 0 || env.ALLOWED_USER_IDS.includes(userId);
}

function listen(connection: VoiceConnection, userId: string): void {
  if (activeUsers.has(userId) || !isAllowed(userId)) return;
  activeUsers.add(userId);

  const startedAt = Date.now();
  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
  });
  const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
  const chunks: Buffer[] = [];
  let packets = 0;

  opusStream.on("data", () => packets++);
  opusStream.on("error", (err) => log(`receive error (${userId}):`, err.message));
  decoder.on("error", (err) => log(`decode error (${userId}):`, err.message));
  decoder.on("data", (chunk: Buffer) => chunks.push(chunk));

  decoder.on("end", () => {
    activeUsers.delete(userId);
    const endedAt = Date.now();
    const pcm = Buffer.concat(chunks);
    const ms = pcmDurationMs(pcm);
    if (ms < 300) {
      log(`ignored ${ms.toFixed(0)}ms blip from ${userId} (${packets} packets)`);
      return;
    }

    const file = join(RECORDINGS_DIR, `${userId}-${startedAt}.wav`);
    writeFileSync(file, pcmToWav(pcm));
    log(`captured ${(ms / 1000).toFixed(2)}s from ${userId} (${packets} packets) -> ${file}`);

    const resource = createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw });
    player.once(AudioPlayerStatus.Playing, () =>
      log(`echo playback started ${Date.now() - endedAt}ms after end of utterance`),
    );
    player.play(resource);
  });

  opusStream.pipe(decoder);
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

  connection.on("stateChange", (from, to) => log(`voice: ${from.status} -> ${to.status}`));
  if (env.VERBOSE) connection.on("debug", (msg) => log("[voice debug]", msg));
  connection.on("error", (err) => log("voice connection error:", err.message));

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      log("disconnected for good; destroying connection");
      connection.destroy();
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    log("failed to reach Ready within 20s — check channel ID and bot Connect/Speak permissions");
    connection.destroy();
    process.exit(1);
  }

  connection.subscribe(player);
  connection.receiver.speaking.on("start", (userId) => {
    log(`speaking start: ${userId}${isAllowed(userId) ? "" : " (not allowlisted, ignored)"}`);
    listen(connection, userId);
  });
  log("ready — say something in the voice channel; you should hear it echoed back");
});

process.on("SIGINT", () => {
  log("shutting down");
  client.destroy();
  process.exit(0);
});

client.login(env.DISCORD_TOKEN);
