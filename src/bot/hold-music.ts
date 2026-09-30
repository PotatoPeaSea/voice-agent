import type { Speaker } from "./speaker.js";
import type { Task } from "../tasks/types.js";

const CHECK_MS = 500;

/** Task statuses where an agent is working and the voice side is just waiting (not on the user). */
export function isWorking(task: Task): boolean {
  return task.status === "starting" || task.status === "running";
}

export interface HoldMusicDeps {
  speaker: Pick<Speaker, "isSpeaking" | "isPlayingBackground" | "playBackground" | "stopBackground">;
  /** True while a background agent is working. */
  waiting: () => boolean;
  /** True while nobody is talking, about to be answered, or has an update queued. */
  quiet: () => boolean;
  /** Music to play, or undefined if there is none. */
  source: (signal: AbortSignal) => AsyncIterable<Buffer> | undefined;
  /** How long it must stay quiet before music starts. */
  delayMs: number;
  log: (...a: unknown[]) => void;
}

/**
 * Fills dead air with music while agents work: starts once the call has been
 * quiet for delayMs with a task running, and stops the moment anyone speaks,
 * a reply starts, or no task is running any more. Speech always wins: the
 * speaker drops background audio whenever it plays a reply.
 */
export class HoldMusic {
  private quietSince?: number;
  private playing?: AbortController;
  private readonly timer?: NodeJS.Timeout;

  constructor(private readonly deps: HoldMusicDeps, checkMs: number | false = CHECK_MS) {
    if (checkMs) this.timer = setInterval(() => this.check(), checkMs);
  }

  get isPlaying(): boolean {
    return !!this.playing;
  }

  check(now = Date.now()): void {
    const { speaker } = this.deps;
    if (this.playing && !speaker.isPlayingBackground) {
      // Replaced by speech or ran out of tracks; wait for a fresh quiet spell.
      this.playing.abort();
      this.playing = undefined;
      this.quietSince = undefined;
    }
    if (!this.deps.waiting() || !this.deps.quiet() || speaker.isSpeaking) {
      if (this.playing) this.stop(this.deps.waiting() ? "conversation" : "tasks done");
      this.quietSince = undefined;
      return;
    }
    this.quietSince ??= now;
    if (this.playing || now - this.quietSince < this.deps.delayMs) return;
    const controller = new AbortController();
    const music = this.deps.source(controller.signal);
    if (!music) {
      this.quietSince = now; // try again after another delay (e.g. files added later)
      return;
    }
    this.playing = controller;
    this.deps.log("hold music: playing while agents work");
    speaker.playBackground(music);
  }

  /** Someone started talking or something is about to be said: stop now and restart the wait. */
  interrupt(): void {
    this.quietSince = undefined;
    if (this.playing) this.stop("interrupted");
  }

  dispose(): void {
    clearInterval(this.timer);
    this.quietSince = undefined;
    if (this.playing) this.stop("left voice");
  }

  private stop(reason: string): void {
    this.playing?.abort();
    this.playing = undefined;
    this.deps.speaker.stopBackground();
    this.deps.log(`hold music: stopped (${reason})`);
  }
}
