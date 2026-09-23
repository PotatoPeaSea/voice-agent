import type { SttFactory, SttProvider, TtsFactory, TtsProvider } from "./types.js";

/**
 * Providers register themselves by name. Adding a new voice API means writing
 * one provider file that calls registerTts/registerStt, plus a config entry.
 */
const ttsFactories = new Map<string, TtsFactory>();
const sttFactories = new Map<string, SttFactory>();

export function registerTts(name: string, factory: TtsFactory): void {
  if (ttsFactories.has(name)) throw new Error(`TTS provider "${name}" is already registered`);
  ttsFactories.set(name, factory);
}

export function registerStt(name: string, factory: SttFactory): void {
  if (sttFactories.has(name)) throw new Error(`STT provider "${name}" is already registered`);
  sttFactories.set(name, factory);
}

export function createTts(name: string, options: Record<string, unknown> = {}): TtsProvider {
  const factory = ttsFactories.get(name);
  if (!factory) throw new Error(`Unknown TTS provider "${name}". Registered: ${[...ttsFactories.keys()].join(", ") || "none"}`);
  return factory(options);
}

export function createStt(name: string, options: Record<string, unknown> = {}): SttProvider {
  const factory = sttFactories.get(name);
  if (!factory) throw new Error(`Unknown STT provider "${name}". Registered: ${[...sttFactories.keys()].join(", ") || "none"}`);
  return factory(options);
}
