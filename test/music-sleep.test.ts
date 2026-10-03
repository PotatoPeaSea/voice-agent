import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { VoiceConnection } from "@discordjs/voice";
import type { Speaker } from "../src/bot/speaker.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ChatEvent, ChatMessage, ChatModel } from "../src/llm/chat.js";
import { Jukebox, songMayPlay } from "../src/bot/jukebox.js";
import { VoiceSession } from "../src/orchestrator/session.js";
import type { SttEvent } from "../src/speech/types.js";
import { AsyncQueue } from "../src/util/async-queue.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stands in for Speaker, used by both the session and the jukebox: speech replaces background audio. */
class FakeSpeaker {
  isSpeaking = false;
  background?: AsyncIterable<Buffer>;
  get isPlayingBackground() {
    return !!this.background;
  }
  async play(audio: AsyncIterable<Buffer>, onStart?: () => void) {
    this.background = undefined;
    this.isSpeaking = true;
    try {
      for await (const _ of audio) onStart?.();
    } finally {
      this.isSpeaking = false;
    }
  }
  stop() {
    this.background = undefined;
    this.isSpeaking = false;
  }
  playBackground(pcm: AsyncIterable<Buffer>) {
    if (this.isSpeaking) return;
    this.background = pcm;
  }
  stopBackground() {
    this.background = undefined;
  }
}

/**
 * An interrupt-mode session and a jukebox sharing one speaker, wired like main.ts. The fake model
 * calls go_quiet when the user says "done" and otherwise answers "Okay."
 */
function setup(idleMs = 10_000) {
  const stt = new AsyncQueue<SttEvent>();
  const spoken: string[] = [];
  const chat = {
    async *streamWithTools(messages: ChatMessage[], tools: ChatCompletionTool[]): AsyncIterable<ChatEvent> {
      const last = messages.at(-1)!;
      if (last.role === "tool") return yield { type: "text", text: "Bye for now." };
      const names = tools.map((t) => (t.type === "function" ? t.function.name : ""));
      if (String(last.content).includes("done") && names.includes("go_quiet")) {
        return yield { type: "tool_calls", calls: [{ id: "c1", name: "go_quiet", arguments: "{}" }] };
      }
      yield { type: "text", text: "Okay." };
    },
  } as unknown as ChatModel;
  const speaker = new FakeSpeaker();
  const connection = { receiver: { subscribe: () => new PassThrough() } } as unknown as VoiceConnection;
  const session = new VoiceSession({
    connection,
    userId: "u1",
    speaker: speaker as unknown as Speaker,
    chat,
    makeStt: () => ({ name: "fake", transcribe: () => stt }),
    async *speak(text) {
      for await (const sentence of text) {
        spoken.push(sentence);
        yield Buffer.alloc(4);
      }
    },
    mode: "interrupt",
    wakeWord: { phrases: ["hey veronica"], idleMs },
    log: () => {},
    verbose: false,
  });
  session.wake();
  const mic = { active: false };
  const starts: { startAtS: number; signal: AbortSignal }[] = [];
  const jukebox = new Jukebox(
    {
      speaker,
      quiet: () => songMayPlay([session], mic.active),
      source: (_file, signal, startAtS) => {
        starts.push({ startAtS, signal });
        return (async function* () {})();
      },
      log: () => {},
    },
    false,
  );
  let clock = 0;
  /** Let the jukebox look at the call over a second or so, as its timer would. */
  const tick = (ms = 1_000) => {
    jukebox.check(clock);
    clock += ms;
    jukebox.check(clock);
  };
  const say = async (text: string) => {
    mic.active = true;
    stt.push({ type: "turn_start" });
    stt.push({ type: "turn_end", text });
    mic.active = false;
    await wait(30);
  };
  const playing = () => speaker.isPlayingBackground;
  const close = () => {
    jukebox.dispose();
    session.close();
  };
  return { session, jukebox, speaker, stt, mic, starts, spoken, say, tick, playing, close };
}

/** Wake the bot and start a song, as play_music would. */
async function startSong(t: ReturnType<typeof setup>) {
  await t.say("hey veronica, play grateful");
  t.jukebox.play("/music/grateful.mp3", "grateful");
  t.tick();
  expect(t.playing()).toBe(true);
}

describe("music while the assistant sleeps", () => {
  it("keeps playing after the user says they're done (go_quiet): paused for the goodbye, then resumed", async () => {
    const t = setup();
    await startSong(t);
    t.tick(30_000);
    await t.say("ok we're done");
    expect(t.spoken.at(-1)).toBe("Bye for now.");
    expect(t.session.listening).toBe(false);
    t.tick();
    expect(t.playing()).toBe(true);
    expect(t.starts).toHaveLength(2);
    expect(t.starts[1].startAtS).toBeGreaterThan(20); // the same song, about where it was
    expect(t.jukebox.current).toBe("grateful");
    t.close();
  });

  it("keeps playing after the idle timeout's \"going quiet\" line", async () => {
    const t = setup(150);
    await startSong(t);
    await wait(250);
    expect(t.spoken.at(-1)).toBe("Going quiet. Say hey veronica when you need me.");
    expect(t.session.listening).toBe(false);
    t.tick();
    expect(t.playing()).toBe(true);
    expect(t.jukebox.current).toBe("grateful");
    t.close();
  });

  it("isn't held back by talk or mic noise the sleeping bot ignores", async () => {
    const t = setup();
    await startSong(t);
    await t.say("ok we're done");
    // People talking among themselves: the mic is active and speech is mid-turn, without the wake word.
    t.mic.active = true;
    t.stt.push({ type: "turn_start" });
    await wait(30);
    expect(t.session.quiet).toBe(true);
    t.tick();
    expect(t.playing()).toBe(true);
    t.tick(60_000);
    expect(t.playing()).toBe(true);
    t.close();
  });

  it("pauses for the wake word and the reply, then resumes the same song", async () => {
    const t = setup();
    await startSong(t);
    await t.say("ok we're done");
    t.tick();
    expect(t.playing()).toBe(true); // resumed after the goodbye
    t.tick(30_000);
    await t.say("hey veronica, what time is it");
    expect(t.session.listening).toBe(true);
    expect(t.spoken.at(-1)).toBe("Okay.");
    t.tick();
    expect(t.playing()).toBe(true);
    expect(t.jukebox.current).toBe("grateful");
    expect(t.starts.at(-1)!.startAtS).toBeGreaterThan(20);
    t.close();
  });

  it("still stops on an explicit stop while asleep, and stays stopped", async () => {
    const t = setup();
    await startSong(t);
    await t.say("ok we're done");
    t.tick();
    expect(t.jukebox.stop()).toBe("grateful");
    expect(t.playing()).toBe(false);
    t.tick(60_000);
    expect(t.playing()).toBe(false);
    t.close();
  });
});

describe("songMayPlay", () => {
  const awake = { quiet: true, listening: true };
  const asleep = { quiet: true, listening: false };

  it("waits for mics to go quiet while anyone is listening", () => {
    expect(songMayPlay([awake], false)).toBe(true);
    expect(songMayPlay([awake], true)).toBe(false);
    expect(songMayPlay([asleep, awake], true)).toBe(false);
    expect(songMayPlay([], true)).toBe(false);
  });

  it("ignores mic activity once every session is asleep", () => {
    expect(songMayPlay([asleep], true)).toBe(true);
    expect(songMayPlay([asleep, asleep], true)).toBe(true);
  });

  it("never plays over a conversation or a reply", () => {
    expect(songMayPlay([{ quiet: false, listening: true }], false)).toBe(false);
    expect(songMayPlay([{ quiet: false, listening: false }], true)).toBe(false); // e.g. a "going quiet" line
  });
});
