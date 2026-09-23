/**
 * Provider-agnostic speech interfaces. Every STT/TTS backend (cloud API or
 * local service) implements one of these, so the pipeline never depends on a vendor.
 *
 * Audio format contract at the boundary: 48kHz, stereo, signed 16-bit LE PCM
 * (Discord's native format). Providers resample internally.
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

export interface Transcript {
  text: string;
  isFinal: boolean;
  /** Provider-reported end of utterance (in addition to our own VAD). */
  speechFinal?: boolean;
}

export interface SttProvider {
  readonly name: string;
  /** Stream PCM in, get partial and final transcripts out while the user is talking. */
  transcribe(audio: AsyncIterable<Buffer>, signal: AbortSignal): AsyncIterable<Transcript>;
}

export type TtsFactory = (options: Record<string, unknown>) => TtsProvider;
export type SttFactory = (options: Record<string, unknown>) => SttProvider;
