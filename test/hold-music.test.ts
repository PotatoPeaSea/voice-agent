import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HoldMusic, isWorking } from "../src/bot/hold-music.js";
import { MusicLibrary, findAudio } from "../src/audio/music.js";
import { pcmToWav } from "../src/audio/wav.js";
import type { Task } from "../src/tasks/types.js";

/** Stands in for Speaker: speech replaces background audio, as on the real player. */
class FakeSpeaker {
  speaking = false;
  background = false;
  starts = 0;
  get isSpeaking() {
    return this.speaking;
  }
  get isPlayingBackground() {
    return this.background;
  }
  playBackground(_pcm: AsyncIterable<Buffer>) {
    if (this.speaking) return;
    this.background = true;
    this.starts++;
  }
  stopBackground() {
    this.background = false;
  }
  say() {
    this.background = false;
    this.speaking = true;
  }
}

async function* silence() {}

function setup(opts: { hasMusic?: boolean } = {}) {
  const speaker = new FakeSpeaker();
  const state = { tasks: 0, quiet: true, conversing: false };
  const aborted: AbortSignal[] = [];
  const music = new HoldMusic(
    {
      speaker,
      waiting: () => state.tasks > 0,
      quiet: () => state.quiet,
      conversing: () => state.conversing,
      source: (signal) => {
        aborted.push(signal);
        return opts.hasMusic === false ? undefined : silence();
      },
      delayMs: 5_000,
      log: () => {},
    },
    false,
  );
  return { speaker, state, music, aborted };
}

describe("HoldMusic", () => {
  it("starts after the delay once a task is dispatched and the call is quiet, and stops when it reports", () => {
    const { speaker, state, music, aborted } = setup();
    music.check(0);
    expect(music.isPlaying).toBe(false); // no task running

    state.tasks = 1; // task dispatched, confirmation spoken, now quiet
    music.check(1_000);
    music.check(5_999);
    expect(music.isPlaying).toBe(false); // short tasks don't trigger it
    music.check(6_000);
    expect(music.isPlaying).toBe(true);
    expect(speaker.background).toBe(true);

    // Task reports back: main.ts interrupts, then the update is spoken.
    music.interrupt();
    expect(speaker.background).toBe(false);
    expect(aborted[0].aborted).toBe(true);
    state.tasks = 0;
    state.quiet = false;
    speaker.say();
    music.check(6_500);
    expect(speaker.starts).toBe(1);
  });

  it("never starts over speech or while the user talks, and restarts the wait afterwards", () => {
    const { speaker, state, music } = setup();
    state.tasks = 1;
    speaker.speaking = true;
    music.check(0);
    music.check(10_000);
    expect(music.isPlaying).toBe(false);

    speaker.speaking = false;
    state.quiet = false; // user talking
    music.check(11_000);
    expect(music.isPlaying).toBe(false);

    state.quiet = true;
    music.check(12_000);
    music.check(16_999);
    expect(music.isPlaying).toBe(false);
    music.check(17_000);
    expect(music.isPlaying).toBe(true);
  });

  it("stops when the user starts talking and resumes after another quiet spell", () => {
    const { speaker, state, music } = setup();
    state.tasks = 1;
    music.check(0);
    music.check(5_000);
    expect(music.isPlaying).toBe(true);

    music.interrupt(); // Discord "speaking start"
    state.quiet = false;
    expect(speaker.background).toBe(false);
    music.check(5_500);
    state.quiet = true;
    music.check(6_000);
    expect(music.isPlaying).toBe(false);
    music.check(11_000);
    expect(music.isPlaying).toBe(true);
    expect(speaker.starts).toBe(2);
  });

  it("keeps playing through mic noise and stops only once a real turn starts", () => {
    const { speaker, state, music } = setup();
    state.tasks = 1;
    music.check(0);
    music.check(5_000);
    expect(music.isPlaying).toBe(true);

    state.quiet = false; // Discord "speaking" from a cough, typing or someone else's mic
    music.check(5_500);
    expect(music.isPlaying).toBe(true);
    expect(speaker.starts).toBe(1);

    state.conversing = true; // speech recognized: the user is talking to the bot
    music.check(6_000);
    expect(music.isPlaying).toBe(false);
    expect(speaker.background).toBe(false);
  });

  it("notices when a reply replaced the music and waits for quiet again", () => {
    const { speaker, state, music } = setup();
    state.tasks = 1;
    music.check(0);
    music.check(5_000);
    speaker.say(); // e.g. a /voice preview or a notice reply
    music.check(5_500);
    expect(music.isPlaying).toBe(false);
    speaker.speaking = false;
    music.check(6_000);
    music.check(10_999);
    expect(music.isPlaying).toBe(false);
    music.check(11_000);
    expect(music.isPlaying).toBe(true);
  });

  it("keeps playing while any of several tasks runs and stops when the last one ends (finished, failed or cancelled)", () => {
    const { speaker, state, music } = setup();
    state.tasks = 2;
    music.check(0);
    music.check(5_000);
    state.tasks = 1;
    music.check(5_500);
    expect(music.isPlaying).toBe(true);
    state.tasks = 0;
    music.check(6_000);
    expect(music.isPlaying).toBe(false);
    expect(speaker.background).toBe(false);
  });

  it("stops and releases the source when leaving voice", () => {
    const { speaker, state, music, aborted } = setup();
    state.tasks = 1;
    music.check(0);
    music.check(5_000);
    music.dispose();
    expect(music.isPlaying).toBe(false);
    expect(speaker.background).toBe(false);
    expect(aborted[0].aborted).toBe(true);
  });

  it("does nothing without music", () => {
    const { speaker, state, music } = setup({ hasMusic: false });
    state.tasks = 1;
    music.check(0);
    music.check(5_000);
    expect(music.isPlaying).toBe(false);
    expect(speaker.starts).toBe(0);
  });

  it("counts only tasks an agent is working on (not ones waiting on the user)", () => {
    const status = (s: Task["status"]) => isWorking({ status: s } as Task);
    expect(["starting", "running"].every((s) => status(s as Task["status"]))).toBe(true);
    expect(["needs_input", "idle", "failed", "cancelled"].some((s) => status(s as Task["status"]))).toBe(false);
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

async function take(iter: AsyncIterable<Buffer>, controller: AbortController, bytes: number): Promise<number> {
  let total = 0;
  for await (const chunk of iter) {
    total += chunk.length;
    if (total >= bytes) controller.abort();
  }
  return total;
}

describe("MusicLibrary", () => {
  const logs: string[] = [];
  const log = (...a: unknown[]) => logs.push(a.join(" "));

  it("finds audio files in a folder or a single file, and nothing at a missing path", () => {
    const dir = mkdtempSync(join(tmpdir(), "music-"));
    writeFileSync(join(dir, "b.mp3"), "");
    writeFileSync(join(dir, "a.WAV"), "");
    writeFileSync(join(dir, "notes.txt"), "");
    expect(findAudio(dir).map((f) => f.slice(dir.length + 1))).toEqual(["a.WAV", "b.mp3"]);
    expect(findAudio(join(dir, "b.mp3"))).toHaveLength(1);
    expect(findAudio(join(dir, "missing"))).toEqual([]);
  });

  it("picks up hold music in the same track, near where it stopped, then carries on with the shuffle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "music-"));
    for (const name of ["a.wav", "b.wav", "c.wav"]) writeFileSync(join(dir, name), "");
    const library = new MusicLibrary(dir, 0.2, log);
    const decoded: { file: string; startAtS: number }[] = [];
    let clock = 0;
    // Each track is two chunks, one second apart.
    (library as unknown as { decode: unknown }).decode = async function* (file: string, _s: AbortSignal, _v: number, startAtS = 0) {
      decoded.push({ file, startAtS });
      yield Buffer.alloc(1);
      clock += 1_000;
      yield Buffer.alloc(1);
    };
    const now = () => clock;

    let controller = new AbortController();
    const first = library.play(controller.signal, now)[Symbol.asyncIterator]();
    await first.next();
    clock += 30_000; // 30s into the track, then a reply cuts it off
    await first.return?.(undefined);
    controller.abort();

    controller = new AbortController();
    expect(await take(library.play(controller.signal, now), controller, 6)).toBe(6);
    const [cut, resumed, ...rest] = decoded;
    expect(resumed).toEqual({ file: cut.file, startAtS: 30 - 1.5 });
    // The rest of the same shuffle, without the interrupted track or a repeat.
    expect(new Set([cut.file, ...rest.map((d) => d.file)]).size).toBe(3);
  });

  it("degrades to no music when ffmpeg can't be run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "music-"));
    writeFileSync(join(dir, "a.wav"), pcmToWav(Buffer.alloc(48_000 * 4)));
    const library = new MusicLibrary(dir, 0.2, log, "no-such-ffmpeg-binary");
    const controller = new AbortController();
    expect(await take(library.play(controller.signal), controller, 1)).toBe(0);
    expect(library.tracks()).toEqual([]);
    expect(logs.some((l) => l.includes("couldn't run ffmpeg"))).toBe(true);
  });

  it.skipIf(!hasFfmpeg)("decodes to 48kHz stereo PCM, loops, and stops on abort", async () => {
    const dir = mkdtempSync(join(tmpdir(), "music-"));
    writeFileSync(join(dir, "tone.wav"), pcmToWav(Buffer.alloc(24_000 * 2 * 1), 24_000, 1)); // 1s mono 24k
    const library = new MusicLibrary(dir, 0.2, log);
    const controller = new AbortController();
    // 1s of 48k stereo is 192000 bytes; ask for more to prove it repeats.
    expect(await take(library.play(controller.signal), controller, 300_000)).toBeGreaterThanOrEqual(300_000);
  });

  it.skipIf(!hasFfmpeg)("skips files ffmpeg can't decode and ends when nothing plays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "music-"));
    writeFileSync(join(dir, "broken.mp3"), "not audio");
    const library = new MusicLibrary(dir, 0.2, log);
    const controller = new AbortController();
    expect(await take(library.play(controller.signal), controller, 1)).toBe(0);
    expect(library.tracks()).toEqual([]);
  });
});
