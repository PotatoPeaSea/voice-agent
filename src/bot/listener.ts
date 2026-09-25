import { EndBehaviorType, type VoiceConnection } from "@discordjs/voice";
import prism from "prism-media";
import { discordToStt, sttSilence } from "../audio/pcm.js";
import { AsyncQueue } from "../util/async-queue.js";

const CHUNK_MS = 80; // Deepgram recommends ~80ms chunks
const SILENCE_AFTER_MS = 100; // no packets this long = user is silent

/**
 * Continuous 16kHz mono audio for one user, suitable for streaming STT.
 *
 * Discord only sends packets while someone is talking, but turn detection
 * needs to hear the silence after speech. A clock emits one chunk every 80ms:
 * the user's real audio when they're talking, zeros when they're not.
 */
export interface UserAudio {
  audio: AsyncQueue<Buffer>;
  /** Epoch ms of the last real audio packet (0 if none yet). */
  lastPacketAt: () => number;
}

export function listenToUser(
  connection: VoiceConnection,
  userId: string,
  signal: AbortSignal,
  log: (...a: unknown[]) => void,
): UserAudio {
  const out = new AsyncQueue<Buffer>();
  const opus = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
  const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let lastPacketAt = 0;

  decoder.on("data", (pcm: Buffer) => {
    const mono = discordToStt(pcm);
    pending.push(mono);
    pendingBytes += mono.length;
    lastPacketAt = Date.now();
  });
  decoder.on("error", (err) => log(`decode error (${userId}):`, err.message));
  opus.on("error", (err) => log(`receive error (${userId}):`, err.message));
  opus.pipe(decoder);

  const clock = setInterval(() => {
    if (pendingBytes > 0) {
      out.push(Buffer.concat(pending));
      pending = [];
      pendingBytes = 0;
    } else if (Date.now() - lastPacketAt > SILENCE_AFTER_MS) {
      out.push(sttSilence(CHUNK_MS));
    }
    // else: mid-speech jitter, wait for the next tick
  }, CHUNK_MS);

  signal.addEventListener(
    "abort",
    () => {
      clearInterval(clock);
      opus.destroy();
      decoder.destroy();
      out.end();
    },
    { once: true },
  );

  return { audio: out, lastPacketAt: () => lastPacketAt };
}

