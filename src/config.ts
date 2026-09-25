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

const EnvSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_GUILD_ID: z.string().min(1, "DISCORD_GUILD_ID is required"),
  DISCORD_VOICE_CHANNEL_ID: z.string().min(1, "DISCORD_VOICE_CHANNEL_ID is required"),
  ALLOWED_USER_IDS: idList,
  VERBOSE: flag,

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
  /** Models agents may never use (comma-separated, matched as substrings of the model id). */
  CLAUDE_BLOCKED_MODELS: idList.transform((l) => (l.length ? l : ["haiku"]).map((m) => m.toLowerCase())),
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
