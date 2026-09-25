import WebSocket from "ws";
import { SampleAligner, monoToStereo } from "../../audio/pcm.js";
import { AsyncQueue } from "../../util/async-queue.js";
import { registerTts } from "../registry.js";
import type { TtsProvider, VoiceInfo, VoiceProfile } from "../types.js";

/**
 * ElevenLabs stream-input WebSocket. The voice ID is part of the URL, so each
 * reply opens its own socket. Works with premade, designed and cloned voices.
 * Docs: elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input
 */
const VOICE_SETTING_KEYS = ["stability", "similarity_boost", "style", "use_speaker_boost"] as const;

class ElevenLabsTts implements TtsProvider {
  readonly name = "elevenlabs";
  constructor(private readonly apiKey: string) {}

  synthesize(text: AsyncIterable<string>, voice: VoiceProfile, signal: AbortSignal): AsyncIterable<Buffer> {
    const queue = new AsyncQueue<Buffer>();
    const aligner = new SampleAligner(2);
    const params = new URLSearchParams({
      model_id: voice.model ?? "eleven_flash_v2_5",
      output_format: "pcm_48000",
      ...(voice.language ? { language_code: voice.language } : {}),
    });
    const ws = new WebSocket(
      `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.voiceId)}/stream-input?${params}`,
      { headers: { "xi-api-key": this.apiKey } },
    );

    const options = voice.providerOptions ?? {};
    const voiceSettings: Record<string, unknown> = {};
    for (const key of VOICE_SETTING_KEYS) if (key in options) voiceSettings[key] = options[key];
    if (voice.speed) voiceSettings.speed = voice.speed;

    const onAbort = () => {
      ws.terminate();
      queue.end();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    ws.on("open", async () => {
      try {
        ws.send(JSON.stringify({ text: " ", voice_settings: voiceSettings }));
        for await (const sentence of text) {
          if (signal.aborted) return;
          // flush: generate this sentence now instead of waiting for more text
          ws.send(JSON.stringify({ text: `${sentence} `, flush: true }));
        }
        if (!signal.aborted) ws.send(JSON.stringify({ text: "" }));
      } catch (err) {
        queue.fail(err);
      }
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { audio?: string | null; isFinal?: boolean; error?: string; message?: string };
      if (msg.error) {
        queue.fail(new Error(`ElevenLabs: ${msg.error} ${msg.message ?? ""}`.trim()));
        return;
      }
      if (msg.audio) {
        const mono = aligner.push(Buffer.from(msg.audio, "base64"));
        if (mono.length) queue.push(monoToStereo(mono));
      }
      if (msg.isFinal) {
        queue.end();
        ws.close();
      }
    });

    ws.on("unexpected-response", (_req, res) => queue.fail(new Error(`ElevenLabs rejected connection: HTTP ${res.statusCode}`)));
    ws.on("error", (err) => queue.fail(err));
    ws.on("close", () => queue.end());
    return queue;
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": this.apiKey } });
    if (!res.ok) throw new Error(`ElevenLabs voices: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { voices: { voice_id: string; name: string; description?: string }[] };
    return body.voices.map((v) => ({ id: v.voice_id, name: v.name, description: v.description ?? undefined }));
  }
}

registerTts("elevenlabs", (options) => {
  const apiKey = options.apiKey as string | undefined;
  if (!apiKey) throw new Error("elevenlabs needs ELEVENLABS_API_KEY in .env");
  return new ElevenLabsTts(apiKey);
});
