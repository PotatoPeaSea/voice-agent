import { readFileSync, writeFileSync } from "node:fs";
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
  /** Profile to use if this one fails (e.g. local service down). */
  fallback: z.string().optional(),
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
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (profile.fallback && !config.profiles[profile.fallback]) {
      throw new Error(`Voice "${name}" falls back to unknown profile "${profile.fallback}"`);
    }
  }
  return config;
}

export function loadVoices(path = "config/voices.yaml"): VoiceConfig {
  return parseVoices(readFileSync(path, "utf8"));
}

/** Rewrite just the `active:` line so the file's comments and layout survive. */
export function withActive(yamlText: string, name: string): string {
  if (!/^active:.*$/m.test(yamlText)) throw new Error("voices.yaml has no top-level `active:` line");
  return yamlText.replace(/^active:.*$/m, `active: ${name}`);
}

/** Switch the live config to another profile and remember it for the next start. */
export function setActiveVoice(config: VoiceConfig, name: string, path = "config/voices.yaml"): void {
  if (!config.profiles[name]) throw new Error(`Unknown voice "${name}"`);
  config.active = name;
  writeFileSync(path, withActive(readFileSync(path, "utf8"), name));
}
