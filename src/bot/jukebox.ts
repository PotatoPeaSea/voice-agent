import type { Speaker } from "./speaker.js";

const CHECK_MS = 250;
/** Quiet time before a song starts or resumes, so it doesn't crowd the end of a reply. */
const START_DELAY_MS = 750;
/** Resume a little before where speech cut in: audio buffered ahead of the player was never heard. */
const RESUME_REWIND_S = 1.5;

export interface JukeboxDeps {
  speaker: Pick<Speaker, "isSpeaking" | "isPlayingBackground" | "playBackground" | "stopBackground">;
  /** True while nobody is talking, about to be answered, or has an update queued. */
  quiet: () => boolean;
  /** The song's audio from startAtS seconds in. */
  source: (file: string, signal: AbortSignal, startAtS: number) => AsyncIterable<Buffer>;
  /** Called right before the song (re)starts, e.g. to stop hold music. */
  beforePlay?: () => void;
  log: (...a: unknown[]) => void;
}

interface Song {
  file: string;
  title: string;
  /** Where to (re)start, in seconds. */
  positionS: number;
  /** Set when the audio ran to the end (not stopped or cut off by speech). */
  ended: boolean;
  quietSince?: number;
  playing?: { controller: AbortController; since: number; startAtS: number };
}

/**
 * Plays songs the user asks for. A requested song waits for the confirming
 * reply to finish, then plays as background audio. Speech still wins: a reply
 * replaces the song on the speaker, and the song resumes where it was once the
 * call is quiet again. It ends when the track does, on stop(), or when another
 * song is requested.
 */
export class Jukebox {
  private song?: Song;
  private readonly timer?: NodeJS.Timeout;

  constructor(private readonly deps: JukeboxDeps, checkMs: number | false = CHECK_MS) {
    if (checkMs) this.timer = setInterval(() => this.check(), checkMs);
  }

  /** The requested song's title, whether it's playing right now or waiting for a reply to finish. */
  get current(): string | undefined {
    return this.song?.title;
  }

  /** Queue a song (replacing any other); it starts once the call is quiet. */
  play(file: string, title: string): void {
    this.stop("another song requested");
    this.song = { file, title, positionS: 0, ended: false };
    this.deps.log(`music: queued ${title}`);
  }

  /** Stop the song, returning its title (undefined if there was none). */
  stop(reason = "asked to"): string | undefined {
    const song = this.song;
    if (!song) return undefined;
    this.song = undefined;
    if (song.playing) {
      song.playing.controller.abort();
      this.deps.speaker.stopBackground();
    }
    this.deps.log(`music: stopped ${song.title} (${reason})`);
    return song.title;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.stop("left voice");
  }

  check(now = Date.now()): void {
    const song = this.song;
    if (!song) return;
    const { speaker, log } = this.deps;
    if (song.playing) {
      if (speaker.isPlayingBackground) return;
      song.playing.controller.abort();
      if (song.ended) {
        this.song = undefined;
        log(`music: finished ${song.title}`);
        return;
      }
      // A reply (or /voice preview) took over the speaker: pick up from here afterwards.
      song.positionS = Math.max(0, song.playing.startAtS + (now - song.playing.since) / 1000 - RESUME_REWIND_S);
      song.playing = undefined;
      log(`music: paused ${song.title} at ${Math.round(song.positionS)}s for speech`);
    }
    if (!this.deps.quiet() || speaker.isSpeaking) {
      song.quietSince = undefined;
      return;
    }
    song.quietSince ??= now;
    if (now - song.quietSince < START_DELAY_MS) return;

    song.quietSince = undefined;
    const controller = new AbortController();
    song.playing = { controller, since: now, startAtS: song.positionS };
    const pcm = this.deps.source(song.file, controller.signal, song.positionS);
    async function* tracked(playing: Song): AsyncIterable<Buffer> {
      yield* pcm;
      if (!controller.signal.aborted) playing.ended = true; // ran out, rather than cut off and aborted
    }
    this.deps.beforePlay?.();
    log(`music: playing ${song.title}${song.positionS ? ` from ${Math.round(song.positionS)}s` : ""}`);
    speaker.playBackground(tracked(song));
  }
}
