import { DISCORD_RATE, SampleAligner, monoToStereo, resampleMono } from "../../audio/pcm.js";
import { AsyncQueue } from "../../util/async-queue.js";
import { registerTts } from "../registry.js";
import type { TtsProvider, VoiceInfo, VoiceProfile } from "../types.js";

/**
 * Self-hosted Qwen3-TTS (services/qwen-tts). One streamed HTTP request per
 * sentence: audio arrives while the sentence is still generating, and the next
 * sentence is requested as soon as the previous one finishes.
 */
class QwenLocalTts implements TtsProvider {
  readonly name = "qwen-local";
  constructor(private readonly baseUrl: string) {}

  synthesize(text: AsyncIterable<string>, voice: VoiceProfile, signal: AbortSignal): AsyncIterable<Buffer> {
    const queue = new AsyncQueue<Buffer>();
    const instruct = voice.providerOptions?.instruct as string | undefined;
    const temperature = voice.providerOptions?.temperature as number | undefined;

    (async () => {
      for await (const sentence of text) {
        if (signal.aborted) break;
        const res = await fetch(`${this.baseUrl}/synthesize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: sentence, speaker: voice.voiceId, language: voice.language, instruct, temperature }),
          signal,
        });
        if (!res.ok || !res.body) throw new Error(`qwen-local HTTP ${res.status}: ${await res.text()}`);
        const rate = Number(res.headers.get("X-Sample-Rate") ?? 24_000);
        const aligner = new SampleAligner(2);
        for await (const chunk of res.body) {
          const mono = aligner.push(Buffer.from(chunk));
          if (mono.length) queue.push(monoToStereo(resampleMono(mono, rate, DISCORD_RATE)));
        }
      }
      queue.end();
    })().catch((err) => (signal.aborted ? queue.end() : queue.fail(err)));

    return queue;
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const res = await fetch(`${this.baseUrl}/speakers`);
    if (!res.ok) throw new Error(`qwen-local HTTP ${res.status}`);
    const speakers = (await res.json()) as string[];
    return speakers.map((s) => ({ id: s, name: s }));
  }
}

registerTts("qwen-local", (options) => new QwenLocalTts((options.baseUrl as string) ?? "http://127.0.0.1:8765"));
