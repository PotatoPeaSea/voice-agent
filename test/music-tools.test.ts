import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchSongs, songTitle } from "../src/audio/songs.js";
import { MusicLibrary } from "../src/audio/music.js";
import { pcmToWav } from "../src/audio/wav.js";
import { Jukebox } from "../src/bot/jukebox.js";
import { MusicTools } from "../src/orchestrator/music-tools.js";

const SONGS = ["/music/grateful.mp3", "/music/moonlight.mp3", "/music/River_Flows-in You.flac", "/music/Don't Stop Me Now.m4a"];

describe("song matching", () => {
  it("titles songs by file name", () => {
    expect(SONGS.map(songTitle)).toEqual(["grateful", "moonlight", "River Flows in You", "Don't Stop Me Now"]);
  });

  const best = (query: string) => matchSongs(query, SONGS)[0]?.title;

  it("matches exact, partial, padded and misheard names", () => {
    expect(best("Moonlight")).toBe("moonlight");
    expect(best("moon")).toBe("moonlight");
    expect(best("moon light")).toBe("moonlight");
    expect(best("play the song moonlight sonata please")).toBe("moonlight");
    expect(best("greatful")).toBe("grateful");
    expect(best("river flows")).toBe("River Flows in You");
    expect(best("flows in you river")).toBe("River Flows in You");
    expect(best("dont stop me now")).toBe("Don't Stop Me Now");
    expect(best("don't stop me")).toBe("Don't Stop Me Now");
  });

  it("finds nothing for unrelated names or just filler", () => {
    expect(matchSongs("bohemian rhapsody", SONGS)).toEqual([]);
    expect(matchSongs("yesterday", SONGS)).toEqual([]);
    expect(matchSongs("play a song", SONGS)).toEqual([]);
  });
});

/** Stands in for Speaker: speech replaces background audio, as on the real player. */
class FakeSpeaker {
  speaking = false;
  background?: AsyncIterable<Buffer>;
  get isSpeaking() {
    return this.speaking;
  }
  get isPlayingBackground() {
    return !!this.background;
  }
  playBackground(pcm: AsyncIterable<Buffer>) {
    if (this.speaking) return;
    this.background = pcm;
  }
  stopBackground() {
    this.background = undefined;
  }
  say() {
    this.background = undefined;
    this.speaking = true;
  }
  /** Drain the background audio as the player would, then go idle. */
  async finish() {
    for await (const _ of this.background!);
    this.background = undefined;
  }
}

function setup() {
  const speaker = new FakeSpeaker();
  const state = { quiet: true };
  const starts: { file: string; startAtS: number; signal: AbortSignal }[] = [];
  let holdMusicStopped = 0;
  const jukebox = new Jukebox(
    {
      speaker,
      quiet: () => state.quiet,
      source: (file, signal, startAtS) => {
        starts.push({ file, startAtS, signal });
        return (async function* () {
          yield Buffer.alloc(4);
        })();
      },
      beforePlay: () => holdMusicStopped++,
      log: () => {},
    },
    false,
  );
  const tools = new MusicTools({ library: { tracks: () => SONGS }, jukebox: () => jukebox });
  return { speaker, state, starts, jukebox, tools, holdMusicStopped: () => holdMusicStopped };
}

describe("Jukebox", () => {
  it("waits for the confirming reply to finish, then plays the song after a short quiet spell", () => {
    const { speaker, state, starts, jukebox, holdMusicStopped } = setup();
    state.quiet = false; // the turn that called play_music is still going
    jukebox.play("/music/moonlight.mp3", "moonlight");
    jukebox.check(0);
    expect(starts).toHaveLength(0);
    state.quiet = true;
    jukebox.check(1_000);
    jukebox.check(1_749);
    expect(starts).toHaveLength(0);
    jukebox.check(1_750);
    expect(starts).toEqual([expect.objectContaining({ file: "/music/moonlight.mp3", startAtS: 0 })]);
    expect(speaker.isPlayingBackground).toBe(true);
    expect(holdMusicStopped()).toBe(1);
    expect(jukebox.current).toBe("moonlight");
  });

  it("pauses when a reply takes the speaker and resumes about where it was", () => {
    const { speaker, starts, jukebox } = setup();
    jukebox.play("/music/grateful.mp3", "grateful");
    jukebox.check(0);
    jukebox.check(1_000); // starts at t=1s
    speaker.say(); // 30s in, a task update is spoken
    jukebox.check(31_000);
    expect(starts[0].signal.aborted).toBe(true);
    expect(jukebox.current).toBe("grateful");
    jukebox.check(35_000);
    expect(starts).toHaveLength(1); // still speaking
    speaker.speaking = false;
    jukebox.check(40_000);
    jukebox.check(40_750);
    expect(starts).toHaveLength(2);
    expect(starts[1].startAtS).toBeCloseTo(28.5); // 30s played, rewound 1.5s
  });

  it("ends when the track runs out", async () => {
    const { speaker, jukebox, starts } = setup();
    jukebox.play("/music/grateful.mp3", "grateful");
    jukebox.check(0);
    jukebox.check(1_000);
    await speaker.finish();
    jukebox.check(200_000);
    expect(jukebox.current).toBeUndefined();
    jukebox.check(300_000);
    expect(starts).toHaveLength(1);
  });

  it("stops on request, and a new song replaces the old one", () => {
    const { speaker, jukebox, starts } = setup();
    jukebox.play("/music/grateful.mp3", "grateful");
    jukebox.check(0);
    jukebox.check(1_000);
    jukebox.play("/music/moonlight.mp3", "moonlight");
    expect(starts[0].signal.aborted).toBe(true);
    expect(speaker.isPlayingBackground).toBe(false);
    expect(jukebox.stop()).toBe("moonlight");
    expect(jukebox.stop()).toBeUndefined();
    jukebox.check(5_000);
    expect(starts).toHaveLength(1);
  });
});

describe("music tools", () => {
  it("lists and searches songs", () => {
    const { tools } = setup();
    expect(tools.execute("list_songs", "")).toEqual({ songs: SONGS.map(songTitle) });
    expect(tools.execute("list_songs", '{"query":"river"}')).toEqual({ query: "river", matches: ["River Flows in You"] });
    expect(tools.execute("list_songs", '{"query":"jazz"}')).toMatchObject({ matches: [], all_songs: expect.any(Array) });
  });

  it("plays a fuzzy match, reports it, and shows it as now playing", () => {
    const { tools, jukebox } = setup();
    expect(tools.execute("play_music", '{"song":"greatful"}')).toMatchObject({ ok: true, playing: "grateful", matched: "greatful" });
    expect(jukebox.current).toBe("grateful");
    expect(tools.execute("list_songs", "{}")).toMatchObject({ now_playing: "grateful" });
    expect(tools.execute("stop_music", "{}")).toEqual({ ok: true, stopped: "grateful" });
    expect(tools.execute("stop_music", "{}")).toMatchObject({ ok: true, note: "No music was playing." });
  });

  it("plays a random song when none is named", () => {
    const { tools, jukebox } = setup();
    expect(tools.execute("play_music", "{}")).toMatchObject({ ok: true });
    expect(SONGS.map(songTitle)).toContain(jukebox.current);
  });

  it("explains when nothing matches, there are no songs, or it isn't in voice", () => {
    const { tools, jukebox } = setup();
    const miss = tools.execute("play_music", '{"song":"bohemian rhapsody"}') as { error: string; available: string[] };
    expect(miss.error).toContain('No song matches "bohemian rhapsody"');
    expect(miss.available).toContain("moonlight");
    expect(jukebox.current).toBeUndefined();

    const empty = new MusicTools({ library: { tracks: () => [] }, jukebox: () => jukebox });
    expect(empty.execute("play_music", '{"song":"moonlight"}')).toHaveProperty("error");
    expect(empty.execute("list_songs", "")).toMatchObject({ songs: [] });

    const offline = new MusicTools({ library: { tracks: () => SONGS }, jukebox: () => undefined });
    expect(offline.execute("play_music", '{"song":"moonlight"}')).toHaveProperty("error");
    expect(offline.execute("list_songs", "")).toMatchObject({ songs: expect.any(Array) });
  });

  it("claims only its own tools", () => {
    const { tools } = setup();
    expect(["list_songs", "play_music", "stop_music"].every((n) => tools.handles(n))).toBe(true);
    expect(tools.handles("dispatch_task")).toBe(false);
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

describe("MusicLibrary.playTrack", () => {
  async function bytes(iter: AsyncIterable<Buffer>): Promise<number> {
    let total = 0;
    for await (const chunk of iter) total += chunk.length;
    return total;
  }

  it.skipIf(!hasFfmpeg)("plays one track once, from an offset, without marking a past-the-end resume as broken", async () => {
    const dir = mkdtempSync(join(tmpdir(), "songs-"));
    const file = join(dir, "tone.wav");
    writeFileSync(file, pcmToWav(Buffer.alloc(48_000 * 2 * 2), 48_000, 1)); // 2s mono
    const library = new MusicLibrary(dir, 0.2, () => {});
    const signal = new AbortController().signal;
    const whole = await bytes(library.playTrack(file, signal, { volume: 0.5 }));
    expect(whole).toBeGreaterThan(48_000 * 4 * 1.9);
    expect(whole).toBeLessThan(48_000 * 4 * 2.1); // once, not looped
    const rest = await bytes(library.playTrack(file, signal, { startAtS: 1 }));
    expect(rest).toBeGreaterThan(48_000 * 4 * 0.9);
    expect(rest).toBeLessThan(48_000 * 4 * 1.1);
    expect(await bytes(library.playTrack(file, signal, { startAtS: 10 }))).toBe(0);
    expect(library.tracks()).toEqual([file]);
  });
});
