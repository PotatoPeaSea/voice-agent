import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { DISCORD_RATE, SampleAligner, monoToStereo } from "../../audio/pcm.js";
import { AsyncQueue } from "../../util/async-queue.js";
import { registerTts } from "../registry.js";
import type { TtsProvider, VoiceInfo, VoiceProfile } from "../types.js";

/**
 * Cartesia Sonic over one persistent WebSocket. Each reply is a separate
 * context_id, so prosody carries across the sentences of a reply and
 * barge-in cancels just that context. Docs: docs.cartesia.ai/api-reference/tts/websocket
 */
const API_VERSION = "2026-08-14";

interface CartesiaMessage {
  type: "chunk" | "done" | "error" | "timestamps" | string;
  context_id?: string;
  data?: string;
  message?: string;
  title?: string;
}

interface Stream {
  queue: AsyncQueue<Buffer>;
  aligner: SampleAligner;
}

class CartesiaTts implements TtsProvider {
  readonly name = "cartesia";
  private ws?: WebSocket;
  private ready?: Promise<WebSocket>;
  private readonly streams = new Map<string, Stream>();

  constructor(private readonly apiKey: string) {}

  /** Open (or reuse) the shared socket. Call at startup to pay the handshake before the first reply. */
  connect(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN && this.ready) return this.ready;
    if (this.ready && this.ws?.readyState === WebSocket.CONNECTING) return this.ready;

    const ws = new WebSocket(`wss://api.cartesia.ai/tts/websocket?cartesia_version=${API_VERSION}`, {
      headers: { "X-API-Key": this.apiKey },
    });
    this.ws = ws;
    this.ready = new Promise((resolve, reject) => {
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`Cartesia rejected connection: HTTP ${res.statusCode}`)));
    });

    ws.on("message", (raw) => this.onMessage(JSON.parse(raw.toString()) as CartesiaMessage));
    ws.on("close", () => {
      for (const [, stream] of this.streams) stream.queue.fail(new Error("Cartesia connection closed"));
      this.streams.clear();
    });
    ws.on("error", () => {}); // surfaced via ready/close
    return this.ready;
  }

  private onMessage(msg: CartesiaMessage): void {
    const stream = msg.context_id ? this.streams.get(msg.context_id) : undefined;
    if (!stream) return;
    if (msg.type === "chunk" && msg.data) {
      const mono = stream.aligner.push(Buffer.from(msg.data, "base64"));
      if (mono.length) stream.queue.push(monoToStereo(mono));
    } else if (msg.type === "done") {
      stream.queue.end();
      this.streams.delete(msg.context_id!);
    } else if (msg.type === "error") {
      stream.queue.fail(new Error(`Cartesia: ${msg.title ?? ""} ${msg.message ?? ""}`.trim()));
      this.streams.delete(msg.context_id!);
    }
  }

  synthesize(text: AsyncIterable<string>, voice: VoiceProfile, signal: AbortSignal): AsyncIterable<Buffer> {
    const contextId = randomUUID();
    const stream: Stream = { queue: new AsyncQueue<Buffer>(), aligner: new SampleAligner(2) };
    this.streams.set(contextId, stream);

    const { emotion, volume, ...rest } = voice.providerOptions ?? {};
    const base = {
      model_id: voice.model ?? "sonic-3.6",
      voice: { mode: "id", id: voice.voiceId },
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: DISCORD_RATE },
      context_id: contextId,
      ...(voice.language ? { language: voice.language } : {}),
      generation_config: {
        ...(voice.speed ? { speed: voice.speed } : {}),
        ...(emotion ? { emotion } : {}),
        ...(volume ? { volume } : {}),
      },
      ...rest,
    };

    const onAbort = () => {
      this.ws?.send(JSON.stringify({ context_id: contextId, cancel: true }));
      this.streams.delete(contextId);
      stream.queue.end();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    (async () => {
      const ws = await this.connect();
      for await (const sentence of text) {
        if (signal.aborted) return;
        ws.send(JSON.stringify({ ...base, transcript: `${sentence} `, continue: true }));
      }
      if (!signal.aborted) ws.send(JSON.stringify({ ...base, transcript: "", continue: false }));
    })().catch((err) => stream.queue.fail(err));

    return stream.queue;
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const res = await fetch("https://api.cartesia.ai/voices?limit=100", {
      headers: { "X-API-Key": this.apiKey, "Cartesia-Version": API_VERSION },
    });
    if (!res.ok) throw new Error(`Cartesia voices: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { data?: VoiceRecord[] } | VoiceRecord[];
    const voices = Array.isArray(body) ? body : (body.data ?? []);
    return voices.map((v) => ({ id: v.id, name: v.name, description: v.description }));
  }
}

interface VoiceRecord {
  id: string;
  name: string;
  description?: string;
}

registerTts("cartesia", (options) => {
  const apiKey = options.apiKey as string | undefined;
  if (!apiKey) throw new Error("cartesia needs CARTESIA_API_KEY in .env");
  return new CartesiaTts(apiKey);
});
