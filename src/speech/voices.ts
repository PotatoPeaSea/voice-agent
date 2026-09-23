import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { VoiceProfile } from "./types.js";

const ProfileSchema = z.object({
  provider: z.string().min(1),
  voiceId: z.string().min(1),
  model: z.string().optional(),
  speed: z.number().positive().optional(),
  language: z.string().optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});

const VoicesFileSchema = z.object({
  active: z.string(),
  profiles: z.record(z.string(), ProfileSchema),
});

export interface VoiceConfig {
  active: string;
  profiles: Record<string, VoiceProfile>;
}

export function parseVoices(yamlText: string): VoiceConfig {
  const config = VoicesFileSchema.parse(parse(yamlText));
  if (!config.profiles[config.active]) {
    throw new Error(`Active voice "${config.active}" is not defined in profiles`);
  }
  return config;
}

export function loadVoices(path = "config/voices.yaml"): VoiceConfig {
  return parseVoices(readFileSync(path, "utf8"));
}
