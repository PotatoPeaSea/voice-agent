import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { VoiceConnection } from "@discordjs/voice";
import type { Speaker } from "../src/bot/speaker.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ChatEvent, ChatMessage, ChatModel } from "../src/llm/chat.js";
import { activeSystemPrompt, setAssistantName, VOICE_SYSTEM_PROMPT } from "../src/orchestrator/prompt.js";
import type { ListenMode } from "../src/orchestrator/listen-mode.js";
import { VoiceSession, containsWakeWord, type SessionDeps } from "../src/orchestrator/session.js";
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

describe("VoiceSession interrupt mode", () => {
  /**
   * A session whose speech recognition events come from `stt`. The fake model records what it was asked,
   * calls go_quiet when the user says "done" (and that tool is offered), and otherwise answers "Okay."
   */
  function setup(idleMs: number, mode: ListenMode = "interrupt") {
    const stt = new AsyncQueue<SttEvent>();
    const heard: string[] = [];
    const spoken: string[] = [];
    const offered: string[][] = [];
    const chat = {
      async *streamWithTools(messages: ChatMessage[], tools: ChatCompletionTool[]): AsyncIterable<ChatEvent> {
        const last = messages.at(-1)!;
        if (last.role === "tool") return yield { type: "text", text: "Bye for now." };
        heard.push(String(last.content));
        const names = tools.map((t) => (t.type === "function" ? t.function.name : ""));
        offered.push(names);
        if (String(last.content).includes("done") && names.includes("go_quiet")) {
          return yield { type: "tool_calls", calls: [{ id: "c1", name: "go_quiet", arguments: "{}" }] };
        }
        yield { type: "text", text: "Okay." };
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
        for await (const sentence of text) {
          spoken.push(sentence);
          yield Buffer.alloc(4);
        }
      },
      onTurnStart: () => turnStarts++,
      mode,
      wakeWord: { phrases: ["hey veronica"], idleMs },
      log: () => {},
      verbose: false,
    });
    session.wake();
    const say = async (text: string) => {
      stt.push({ type: "turn_start" });
      stt.push({ type: "turn_end", text });
      await wait(30);
    };
    return { session, heard, spoken, offered, say, turnStarts: () => turnStarts };
  }

  it("ignores speech until the wake word, then converses, then says it's going quiet when idle", async () => {
    const { session, heard, spoken, say, turnStarts } = setup(150);
    await say("what's the weather");
    expect(heard).toEqual([]);
    expect(turnStarts()).toBe(0); // hold music isn't interrupted by speech it ignores

    await say("Hey Veronica, what's the weather?");
    await say("and tomorrow?");
    expect(heard).toEqual(["Hey Veronica, what's the weather?", "and tomorrow?"]);

    await wait(250);
    expect(spoken.at(-1)).toBe("Going quiet. Say hey veronica when you need me.");
    await say("are you there");
    expect(heard).toHaveLength(2);
    session.close();
  });

  it("keeps listening while the conversation continues", async () => {
    const { session, heard, say } = setup(150);
    await say("hey veronica");
    for (let i = 0; i < 4; i++) {
      await wait(80);
      await say(`question ${i}`);
    }
    expect(heard).toHaveLength(5);
    session.close();
  });

  it("goes quiet after a goodbye when the user says they're done (go_quiet)", async () => {
    const { session, heard, spoken, offered, say } = setup(10_000);
    await say("hey veronica");
    expect(offered[0]).toContain("go_quiet");
    await say("ok we're done");
    expect(spoken.at(-1)).toBe("Bye for now.");
    await say("still there?");
    expect(heard).toEqual(["hey veronica", "ok we're done"]);
    await say("hey veronica, one more thing");
    expect(heard).toHaveLength(3);
    session.close();
  });

  it("switches modes at runtime (/mode)", async () => {
    const { session, heard, offered, say } = setup(10_000, "default");
    await say("hello");
    expect(offered[0]).not.toContain("go_quiet");

    session.setMode("interrupt"); // starts out waiting for the wake word
    await say("are you listening");
    expect(heard).toEqual(["hello"]);
    await say("hey veronica");
    expect(offered.at(-1)).toContain("go_quiet");

    session.setMode("default");
    await say("ok we're done"); // go_quiet no longer offered, so it keeps listening
    await say("still here?");
    expect(heard).toEqual(["hello", "hey veronica", "ok we're done", "still here?"]);
    session.close();
  });

  it("refuses interrupt mode without wake words", () => {
    const speaker = { stop() {} } as unknown as Speaker;
    const s = new VoiceSession({ ...({} as SessionDeps), speaker, log: () => {}, verbose: false });
    expect(() => s.setMode("interrupt")).toThrow(/wake words/);
    s.close();
  });
});

describe("assistant name", () => {
  afterEach(() => setAssistantName(undefined));

  it("tells the model its name", () => {
    setAssistantName("Veronica");
    expect(activeSystemPrompt()).toMatch(/^Your name is Veronica;/);
    expect(activeSystemPrompt()).toContain(VOICE_SYSTEM_PROMPT);
  });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
