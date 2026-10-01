import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { VoiceConnection } from "@discordjs/voice";
import type { Speaker } from "../src/bot/speaker.js";
import type { ChatMessage, ChatModel } from "../src/llm/chat.js";
import { VoiceSession, containsWakeWord } from "../src/orchestrator/session.js";
import type { SttEvent } from "../src/speech/types.js";
import { AsyncQueue } from "../src/util/async-queue.js";

describe("containsWakeWord", () => {
  const phrases = ["hey jarvis"];

  it("ignores case and punctuation", () => {
    expect(containsWakeWord("Hey, Jarvis!", phrases)).toBe(true);
    expect(containsWakeWord("HEY JARVIS what's the time", phrases)).toBe(true);
  });

  it("matches anywhere in the turn", () => {
    expect(containsWakeWord("Okay. Hey Jarvis, check the build.", phrases)).toBe(true);
  });

  it("matches whole words only", () => {
    expect(containsWakeWord("they jarvisized it", phrases)).toBe(false);
    expect(containsWakeWord("jarvis, are you there", phrases)).toBe(false);
  });

  it("accepts any of several phrases and skips blank ones", () => {
    expect(containsWakeWord("Jarvis, are you there?", ["hey jarvis", "jarvis"])).toBe(true);
    expect(containsWakeWord("anything at all", [" ", ""])).toBe(false);
  });
});

describe("VoiceSession wake word mode", () => {
  /** A session whose speech recognition events come from `stt` and whose model records what it was asked. */
  function setup(idleMs: number) {
    const stt = new AsyncQueue<SttEvent>();
    const heard: string[] = [];
    const chat = {
      async *streamWithTools(messages: ChatMessage[]) {
        heard.push(String(messages.at(-1)?.content));
        yield { type: "text" as const, text: "Okay." };
      },
    } as unknown as ChatModel;
    const speaker = {
      isSpeaking: false,
      stop() {},
      async play(audio: AsyncIterable<Buffer>, onStart: () => void) {
        for await (const _ of audio) onStart();
      },
    } as unknown as Speaker;
    const connection = { receiver: { subscribe: () => new PassThrough() } } as unknown as VoiceConnection;
    let turnStarts = 0;
    const session = new VoiceSession({
      connection,
      userId: "u1",
      speaker,
      chat,
      makeStt: () => ({ name: "fake", transcribe: () => stt }),
      async *speak(text) {
        for await (const _ of text) yield Buffer.alloc(4);
      },
      onTurnStart: () => turnStarts++,
      wakeWord: { phrases: ["hey jarvis"], idleMs },
      log: () => {},
      verbose: false,
    });
    session.wake();
    const say = async (text: string) => {
      stt.push({ type: "turn_start" });
      stt.push({ type: "turn_end", text });
      await new Promise((r) => setTimeout(r, 30));
    };
    return { session, heard, say, turnStarts: () => turnStarts };
  }

  it("ignores speech until the wake word, then converses, then sleeps again when idle", async () => {
    const { session, heard, say, turnStarts } = setup(150);
    await say("what's the weather");
    expect(heard).toEqual([]);
    expect(turnStarts()).toBe(0); // hold music isn't interrupted by speech it ignores

    await say("Hey Jarvis, what's the weather?");
    await say("and tomorrow?");
    expect(heard).toEqual(["Hey Jarvis, what's the weather?", "and tomorrow?"]);

    await new Promise((r) => setTimeout(r, 250));
    await say("are you there");
    expect(heard).toHaveLength(2);
    session.close();
  });

  it("keeps listening while the conversation continues", async () => {
    const { session, heard, say } = setup(150);
    await say("hey jarvis");
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 80));
      await say(`question ${i}`);
    }
    expect(heard).toHaveLength(5);
    session.close();
  });
});
