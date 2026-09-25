import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { DISCORD_RATE, SampleAligner, monoToStereo, resampleMono } from "../../audio/pcm.js";
import { AsyncQueue } from "../../util/async-queue.js";
import { registerTts } from "../registry.js";
import type { TtsProvider, VoiceInfo, VoiceProfile } from "../types.js";

/**
 * Qwen3-TTS on Alibaba Cloud Model Studio (DashScope) realtime WebSocket.
 * Streams audio within a sentence. Docs: alibabacloud.com/help/en/model-studio/qwen-tts-realtime
 */
const HOSTS: Record<string, string> = {
  intl: "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime",
  cn: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
};
const SAMPLE_RATE = 24_000;

// Premade voices usable with qwen3-tts-flash-realtime (not exhaustive).
const KNOWN_VOICES: VoiceInfo[] = [
  { id: "Cherry", name: "Cherry", description: "bright, friendly female" },
  { id: "Ethan", name: "Ethan", description: "warm, energetic male" },
  { id: "Serena", name: "Serena", description: "gentle female" },
  { id: "Chelsie", name: "Chelsie", description: "young female" },
];

interface ServerEvent {
  type: string;
  delta?: string;
  error?: { message?: string; code?: string };
}

class QwenCloudTts implements TtsProvider {
  readonly name = "qwen-cloud";
  constructor(
    private readonly apiKey: string,
    private readonly region: string,
  ) {}

  synthesize(text: AsyncIterable<string>, voice: VoiceProfile, signal: AbortSignal): AsyncIterable<Buffer> {
    const queue = new AsyncQueue<Buffer>();
    const aligner = new SampleAligner(2);
    const model = voice.model ?? "qwen3-tts-flash-realtime";
    const ws = new WebSocket(`${HOSTS[this.region] ?? HOSTS.intl}?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    const send = (type: string, body: object = {}) => ws.send(JSON.stringify({ type, event_id: randomUUID(), ...body }));

    signal.addEventListener("abort", () => {
      ws.terminate();
      queue.end();
    }, { once: true });

    ws.on("open", async () => {
      try {
        send("session.update", {
          session: {
            voice: voice.voiceId,
            mode: "server_commit",
            response_format: "pcm",
            sample_rate: SAMPLE_RATE,
            ...(voice.language ? { language_type: voice.language } : {}),
            ...(voice.providerOptions ?? {}),
          },
        });
        for await (const sentence of text) {
          if (signal.aborted) return;
          send("input_text_buffer.append", { text: `${sentence} ` });
        }
        if (!signal.aborted) send("session.finish");
      } catch (err) {
        queue.fail(err);
      }
    });

    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as ServerEvent;
      if (event.type === "response.audio.delta" && event.delta) {
        const mono = aligner.push(Buffer.from(event.delta, "base64"));
        if (mono.length) queue.push(monoToStereo(resampleMono(mono, SAMPLE_RATE, DISCORD_RATE)));
      } else if (event.type === "session.finished") {
        queue.end();
        ws.close();
      } else if (event.type === "error") {
        queue.fail(new Error(`qwen-cloud: ${event.error?.code ?? ""} ${event.error?.message ?? ""}`.trim()));
        ws.close();
      }
    });

    ws.on("unexpected-response", (_req, res) => queue.fail(new Error(`qwen-cloud rejected connection: HTTP ${res.statusCode}`)));
    ws.on("error", (err) => queue.fail(err));
    ws.on("close", () => queue.end());
    return queue;
  }

  async listVoices(): Promise<VoiceInfo[]> {
    return KNOWN_VOICES;
  }
}

registerTts("qwen-cloud", (options) => {
  const apiKey = options.apiKey as string | undefined;
  if (!apiKey) throw new Error("qwen-cloud needs DASHSCOPE_API_KEY in .env");
  return new QwenCloudTts(apiKey, (options.region as string) ?? "intl");
});
