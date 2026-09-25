import type { Env } from "../config.js";
import { speakWithFallback, type Voice } from "./fallback.js";
import { createStt, createTts } from "./registry.js";
import type { SttProvider, TtsProvider } from "./types.js";
import type { VoiceConfig } from "./voices.js";

// Importing a provider module registers it. Add new providers here.
import "./stt/deepgram-flux.js";
import "./tts/cartesia.js";
import "./tts/elevenlabs.js";
import "./tts/qwen-local.js";
import "./tts/qwen-cloud.js";

/** Constructor options for each provider, by registered name (API keys, endpoints). */
function optionsFor(provider: string, env: Env): Record<string, unknown> {
  const options: Record<string, Record<string, unknown>> = {
    "deepgram-flux": { apiKey: env.DEEPGRAM_API_KEY },
    cartesia: { apiKey: env.CARTESIA_API_KEY },
    elevenlabs: { apiKey: env.ELEVENLABS_API_KEY },
    "qwen-local": { baseUrl: env.QWEN_TTS_URL },
    "qwen-cloud": { apiKey: env.DASHSCOPE_API_KEY, region: env.DASHSCOPE_REGION },
  };
  return options[provider] ?? {};
}

export function makeStt(env: Env, options: Record<string, unknown> = {}): SttProvider {
  return createStt(env.STT_PROVIDER, { ...optionsFor(env.STT_PROVIDER, env), ...options });
}

const ttsCache = new Map<string, TtsProvider>();

/** One instance per provider so persistent connections are shared across replies. */
export function getTts(provider: string, env: Env): TtsProvider {
  let tts = ttsCache.get(provider);
  if (!tts) {
    tts = createTts(provider, optionsFor(provider, env));
    ttsCache.set(provider, tts);
  }
  return tts;
}

const warnedFallbacks = new Set<string>();

/**
 * Resolve a named voice profile (and its fallback, if any) to providers.
 * A fallback that can't be created (e.g. missing API key) is skipped with a warning.
 */
export function resolveVoice(voices: VoiceConfig, name: string, env: Env): { primary: Voice; fallback?: Voice } {
  const profile = voices.profiles[name];
  if (!profile) throw new Error(`Unknown voice profile "${name}"`);
  const primary = { tts: getTts(profile.provider, env), profile };
  const fallbackProfile = profile.fallback ? voices.profiles[profile.fallback] : undefined;
  if (!fallbackProfile) return { primary };
  try {
    return { primary, fallback: { tts: getTts(fallbackProfile.provider, env), profile: fallbackProfile } };
  } catch (err) {
    if (!warnedFallbacks.has(profile.fallback!)) {
      warnedFallbacks.add(profile.fallback!);
      console.warn(`voice fallback "${profile.fallback}" disabled: ${(err as Error).message}`);
    }
    return { primary };
  }
}

/** Speak streamed text with the active voice profile, failing over if configured. */
export function speak(
  voices: VoiceConfig,
  env: Env,
  text: AsyncIterable<string>,
  signal: AbortSignal,
  log: (...a: unknown[]) => void,
): AsyncIterable<Buffer> {
  const { primary, fallback } = resolveVoice(voices, voices.active, env);
  return speakWithFallback(primary, fallback, text, signal, log);
}
