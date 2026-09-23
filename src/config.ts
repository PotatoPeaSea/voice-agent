import "dotenv/config";
import { z } from "zod";

const idList = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));

const EnvSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_GUILD_ID: z.string().min(1, "DISCORD_GUILD_ID is required"),
  DISCORD_VOICE_CHANNEL_ID: z.string().min(1, "DISCORD_VOICE_CHANNEL_ID is required"),
  ALLOWED_USER_IDS: idList,
  VERBOSE: z.string().optional().transform((v) => v === "1" || v === "true"),
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
