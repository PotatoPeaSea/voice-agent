/**
 * Provider-agnostic speech interfaces. Every STT/TTS backend (cloud API or
 * local service) implements one of these, so the pipeline never depends on a vendor.
 *
 * Audio formats at the boundary (signed 16-bit little-endian PCM):
 *   - STT input:  16kHz mono
 *   - TTS output: 48kHz stereo (Discord's native format)
 * Providers convert internally (see src/audio/pcm.ts).
 */

export interface VoiceProfile {
  /** Registered provider name, e.g. "elevenlabs", "cartesia", "kokoro". */
  provider: string;
  voiceId: string;
  model?: string;
  speed?: number;
  language?: string;
  /** Vendor-specific knobs passed through untouched (stability, style, emotion, ...). */
  providerOptions?: Record<string, unknown>;
  /** Name of another profile to use if this one fails. */
  fallback?: string;
}

export interface VoiceInfo {
  id: string;
  name: string;
  description?: string;
}

export interface TtsProvider {
  readonly name: string;
  /**
   * Synthesize streamed text (e.g. LLM sentences as they are produced) into
   * streamed PCM. Aborting the signal must stop synthesis promptly (barge-in).
   */
  synthesize(text: AsyncIterable<string>, voice: VoiceProfile, signal: AbortSignal): AsyncIterable<Buffer>;
  listVoices(): Promise<VoiceInfo[]>;
  /** Optional: create a custom voice from sample audio; returns the new voiceId. */
  cloneVoice?(name: string, samples: Buffer[]): Promise<string>;
}

/**
 * Turn-level transcription events. Providers without built-in turn detection
 * must pair with a VAD to produce turn_start / turn_end.
 */
export type SttEvent =
  | { type: "turn_start" }
  | { type: "partial"; text: string }
  | { type: "turn_end"; text: string };

export interface SttProvider {
  readonly name: string;
  /** Stream PCM in continuously (including silence), get turn events out while the user talks. */
  transcribe(audio: AsyncIterable<Buffer>, signal: AbortSignal): AsyncIterable<SttEvent>;
}

export type TtsFactory = (options: Record<string, unknown>) => TtsProvider;
export type SttFactory = (options: Record<string, unknown>) => SttProvider;
