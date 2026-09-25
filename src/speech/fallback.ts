import type { TtsProvider, VoiceProfile } from "./types.js";

export interface Voice {
  tts: TtsProvider;
  profile: VoiceProfile;
}

const FIRST_AUDIO_TIMEOUT_MS = 5_000;
const COOL_DOWN_MS = 60_000;
const downUntil = new Map<string, number>();

function isDown(voice: Voice): boolean {
  return (downUntil.get(voice.tts.name) ?? 0) > Date.now();
}

/**
 * Splits one text stream between successive consumers. When a consumer is
 * retired, any sentence it was waiting on is handed to the next one instead
 * of being lost.
 */
class TextFeed {
  private readonly source: AsyncIterator<string>;
  private readonly pending: string[] = [];
  private generation = 0;
  /** Sentences handed to the current consumer. */
  sent: string[] = [];

  constructor(text: AsyncIterable<string>) {
    this.source = text[Symbol.asyncIterator]();
  }

  /** Retire the current consumer and start a new one, optionally replaying sentences first. */
  async *next(replay: string[] = []): AsyncIterable<string> {
    const id = ++this.generation;
    this.sent = [...replay];
    yield* replay;
    while (id === this.generation) {
      let value = this.pending.shift();
      if (value === undefined) {
        const next = await this.source.next();
        if (next.done) return;
        value = next.value;
        if (id !== this.generation) {
          this.pending.push(value);
          return;
        }
      }
      this.sent.push(value);
      yield value;
    }
  }
}

/**
 * Speak with the primary voice, falling back to the secondary if the primary
 * errors or produces no audio in time. A failed primary is skipped for a cool-down
 * period. If it fails before any audio, the whole reply is replayed on the fallback;
 * if it fails mid-reply, the fallback continues with the sentences not yet sent.
 */
export async function* speakWithFallback(
  primary: Voice,
  secondary: Voice | undefined,
  text: AsyncIterable<string>,
  signal: AbortSignal,
  log: (...a: unknown[]) => void,
): AsyncIterable<Buffer> {
  const feed = new TextFeed(text);

  if (!secondary || isDown(primary)) {
    const voice = secondary ?? primary;
    yield* voice.tts.synthesize(feed.next(), voice.profile, signal);
    return;
  }

  const primaryAbort = new AbortController();
  const onAbort = () => primaryAbort.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  let gotAudio = false;
  try {
    const audio = primary.tts.synthesize(feed.next(), primary.profile, primaryAbort.signal)[Symbol.asyncIterator]();
    while (true) {
      const next = gotAudio ? await audio.next() : await withTimeout(audio.next(), FIRST_AUDIO_TIMEOUT_MS);
      if (next.done) return;
      gotAudio = true;
      yield next.value;
    }
  } catch (err) {
    if (signal.aborted) return;
    downUntil.set(primary.tts.name, Date.now() + COOL_DOWN_MS);
    log(`tts ${primary.tts.name} failed (${(err as Error).message}); using ${secondary.tts.name} for ${COOL_DOWN_MS / 1000}s`);
  } finally {
    signal.removeEventListener("abort", onAbort);
    primaryAbort.abort();
  }

  const replay = gotAudio ? [] : feed.sent;
  yield* secondary.tts.synthesize(feed.next(replay), secondary.profile, signal);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no audio within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
