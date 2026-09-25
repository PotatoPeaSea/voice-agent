import WebSocket from "ws";
import { STT_RATE } from "../../audio/pcm.js";
import { AsyncQueue } from "../../util/async-queue.js";
import { registerStt } from "../registry.js";
import type { SttEvent, SttProvider } from "../types.js";

/**
 * Deepgram Flux: streaming STT with built-in end-of-turn detection,
 * so no separate VAD is needed. Docs: developers.deepgram.com/docs/flux
 */
interface FluxOptions {
  apiKey: string;
  model?: string;
  /** Confidence needed to end a turn (0.5-1.0). Lower = snappier, more false cut-offs. */
  eotThreshold?: number;
  /** Force end of turn after this much silence regardless of confidence. */
  eotTimeoutMs?: number;
}

interface FluxMessage {
  type: string;
  event?: "Update" | "StartOfTurn" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn";
  transcript?: string;
  code?: string;
  description?: string;
}

class DeepgramFluxStt implements SttProvider {
  readonly name = "deepgram-flux";
  constructor(private readonly opts: FluxOptions) {}

  transcribe(audio: AsyncIterable<Buffer>, signal: AbortSignal): AsyncIterable<SttEvent> {
    const events = new AsyncQueue<SttEvent>();
    const params = new URLSearchParams({
      model: this.opts.model ?? "flux-general-en",
      encoding: "linear16",
      sample_rate: String(STT_RATE),
      eot_threshold: String(this.opts.eotThreshold ?? 0.7),
      eot_timeout_ms: String(this.opts.eotTimeoutMs ?? 3000),
    });
    const ws = new WebSocket(`wss://api.deepgram.com/v2/listen?${params}`, {
      headers: { Authorization: `Token ${this.opts.apiKey}` },
    });

    const close = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "CloseStream" }));
        ws.close();
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
      events.end();
    };
    signal.addEventListener("abort", close, { once: true });

    ws.on("open", async () => {
      try {
        for await (const chunk of audio) {
          if (signal.aborted || ws.readyState !== WebSocket.OPEN) break;
          ws.send(chunk);
        }
      } catch (err) {
        events.fail(err);
      }
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as FluxMessage;
      if (msg.type === "Error") {
        events.fail(new Error(`Deepgram ${msg.code}: ${msg.description}`));
        return;
      }
      if (msg.type !== "TurnInfo") return;
      const text = (msg.transcript ?? "").trim();
      switch (msg.event) {
        case "StartOfTurn":
          events.push({ type: "turn_start" });
          break;
        case "Update":
          if (text) events.push({ type: "partial", text });
          break;
        case "EndOfTurn":
          events.push({ type: "turn_end", text });
          break;
      }
    });

    ws.on("unexpected-response", (_req, res) =>
      events.fail(new Error(`Deepgram rejected connection: HTTP ${res.statusCode}`)),
    );
    ws.on("error", (err) => events.fail(err));
    ws.on("close", (code, reason) => {
      if (!signal.aborted && !events.isClosed) {
        events.fail(new Error(`Deepgram closed unexpectedly (${code} ${reason.toString()})`));
      }
    });

    return events;
  }
}

registerStt("deepgram-flux", (options) => {
  const apiKey = options.apiKey as string | undefined;
  if (!apiKey) throw new Error("deepgram-flux needs DEEPGRAM_API_KEY in .env");
  return new DeepgramFluxStt({ ...(options as Partial<FluxOptions>), apiKey });
});
