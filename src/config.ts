import "dotenv/config";
import { z } from "zod";

const idList = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));

const optional = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined));

/** A string setting where blank means "use the default". */
const withDefault = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((v) => v?.trim() || fallback);

const flag = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

/** A true/false setting where blank means true. */
const flagDefaultOn = z
  .string()
  .optional()
  .transform((v) => !v?.trim() || v.trim() === "1" || v.trim() === "true");

/** A number setting where blank means "use the default". */
const numberWithDefault = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? Number(v) : fallback))
    .pipe(z.number().min(min).max(max));

const EnvSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_GUILD_ID: z.string().min(1, "DISCORD_GUILD_ID is required"),
  DISCORD_VOICE_CHANNEL_ID: z.string().min(1, "DISCORD_VOICE_CHANNEL_ID is required"),
  ALLOWED_USER_IDS: idList,
  VERBOSE: flag,
  /**
   * Follow allowed users: join the voice channel they're in and leave once it's empty.
   * Off = join DISCORD_VOICE_CHANNEL_ID at startup and move only with /join and /leave.
   */
  VOICE_AUTO_JOIN: flagDefaultOn,

  LLM_BASE_URL: z.string().default("https://api.deepseek.com"),
  LLM_API_KEY: optional,
  LLM_MODEL: z.string().default("deepseek-flash"),
  /** Reasoning adds seconds of latency; keep it off for the conversational front model. */
  LLM_THINKING: flag,

  STT_PROVIDER: z.string().default("deepgram-flux"),
  DEEPGRAM_API_KEY: optional,
  CARTESIA_API_KEY: optional,
  ELEVENLABS_API_KEY: optional,
  QWEN_TTS_URL: z.string().default("http://127.0.0.1:8765"),
  DASHSCOPE_API_KEY: optional,
  /** "intl" (Singapore) or "cn" (Beijing) Model Studio region. */
  DASHSCOPE_REGION: z.enum(["intl", "cn"]).default("intl"),

  /** Folders Claude Code tasks may run in (comma-separated). Defaults to the folder containing this project. */
  WORKER_ROOTS: z.string().optional(),
  /**
   * Fallback Claude Code settings for new tasks when neither the user nor the front model picks one.
   * (The front model normally chooses per task; see the system prompt.)
   */
  CLAUDE_MODEL: withDefault("sonnet"),
  CLAUDE_EFFORT: withDefault("medium"),
  /** Blank = your Claude Code settings' default permission mode. */
  CLAUDE_MODE: optional,
  /** Models agents (Claude Code and Hermes) may never use (comma-separated, matched as substrings of the model id). */
  CLAUDE_BLOCKED_MODELS: idList.transform((l) => (l.length ? l : ["haiku"]).map((m) => m.toLowerCase())),

  /**
   * Command that starts Hermes Agent's ACP server (e.g. "hermes-acp") to offer Hermes as a second worker.
   * Blank or "off" = Claude Code only.
   */
  HERMES_ACP_COMMAND: withDefault("off"),
  /** Fallback Hermes model (a provider:model id or name from `npm run agent:probe -- hermes`). Blank = Hermes's configured default. */
  HERMES_MODEL: optional,
  /** Hermes edit approval: default, accept_edits or dont_ask. Blank = default (asks before edits). */
  HERMES_MODE: optional,

  /**
   * Text channel for task reports: one thread per task with live progress and the full report.
   * Blank = post into the voice channel's own text chat (no threads).
   */
  DISCORD_REPORTS_CHANNEL_ID: optional,

  /** Play music in voice while agents work and there's nothing to say (needs ffmpeg and files at MUSIC_PATH). */
  MUSIC_ENABLED: flagDefaultOn,
  /** An audio file or a folder of them (mp3, wav, ogg, flac, m4a...), relative to where the bot starts. */
  MUSIC_PATH: withDefault("music"),
  /** Seconds of quiet before the music starts, so short tasks don't trigger it. */
  MUSIC_DELAY_SECONDS: numberWithDefault(5, 0, 600),
  /** Music volume, 0-1 (speech plays at full volume). */
  MUSIC_VOLUME: numberWithDefault(0.2, 0, 1),
  /** Volume of songs the user asks for (play_music), 0-1; they come from MUSIC_PATH even with MUSIC_ENABLED off. */
  MUSIC_SONG_VOLUME: numberWithDefault(0.5, 0, 1),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment (see .env.example):\n${problems}`);
  }
  return parsed.data;
}
