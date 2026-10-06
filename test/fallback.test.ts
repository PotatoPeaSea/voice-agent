import { describe, expect, it, vi } from "vitest";
import { speakWithFallback, type Voice } from "../src/speech/fallback.js";
import type { TtsProvider } from "../src/speech/types.js";

/** Fake TTS: emits one buffer per sentence containing the sentence text, or fails. */
function fakeVoice(name: string, behaviour: "ok" | "fail-first" | "fail-second"): Voice & { heard: string[] } {
  const heard: string[] = [];
  const tts: TtsProvider = {
    name,
    async *synthesize(text) {
      let i = 0;
      for await (const sentence of text) {
        heard.push(sentence);
        if ((behaviour === "fail-first" && i === 0) || (behaviour === "fail-second" && i === 1)) {
          throw new Error(`${name} down`);
        }
        i++;
        yield Buffer.from(`${name}:${sentence}`);
      }
    },
    listVoices: async () => [],
  };
  return { tts, profile: { provider: name, voiceId: "v" }, heard };
}

async function run(primary: Voice, secondary: Voice | undefined, ...sentences: string[]): Promise<string[]> {
  async function* text() {
    yield* sentences;
  }
  const out: string[] = [];
  for await (const pcm of speakWithFallback(primary, secondary, text(), new AbortController().signal, () => {})) {
    out.push(pcm.toString());
  }
  return out;
}

describe("speakWithFallback", () => {
  it("uses the primary when it works", async () => {
    const out = await run(fakeVoice("a", "ok"), fakeVoice("b", "ok"), "one.", "two.");
    expect(out).toEqual(["a:one.", "a:two."]);
  });

  it("replays the whole reply on the fallback if the primary fails before any audio", async () => {
    const out = await run(fakeVoice("p1", "fail-first"), fakeVoice("b", "ok"), "one.", "two.");
    expect(out).toEqual(["b:one.", "b:two."]);
  });

  it("skips a failed primary during its cool-down", async () => {
    const primary = fakeVoice("p1", "ok"); // same name as the provider that just failed
    const out = await run(primary, fakeVoice("b", "ok"), "hi.");
    expect(out).toEqual(["b:hi."]);
    expect(primary.heard).toEqual([]);
  });

  it("continues on the fallback mid-reply without losing later sentences", async () => {
    const out = await run(fakeVoice("p2", "fail-second"), fakeVoice("b", "ok"), "one.", "two.", "three.");
    expect(out[0]).toBe("p2:one.");
    expect(out).toContain("b:three.");
  });

  it("doesn't count the model's thinking time against the voice's first-audio timeout", async () => {
    vi.useFakeTimers();
    try {
      const primary = fakeVoice("slow-llm-primary", "ok");
      const secondary = fakeVoice("slow-llm-secondary", "ok");
      // The model spends 20s generating a long tool call before it says anything.
      async function* text() {
        await new Promise((r) => setTimeout(r, 20_000));
        yield "done.";
      }
      const out: string[] = [];
      const reply = (async () => {
        for await (const pcm of speakWithFallback(primary, secondary, text(), new AbortController().signal, () => {})) {
          out.push(pcm.toString());
        }
      })();
      await vi.advanceTimersByTimeAsync(20_000);
      await reply;
      expect(out).toEqual(["slow-llm-primary:done."]);
      expect(secondary.heard).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still falls back when the voice is slow after it has the text", async () => {
    vi.useFakeTimers();
    try {
      const secondary = fakeVoice("slow-voice-secondary", "ok");
      const stuck: Voice = {
        profile: { provider: "slow-voice-primary", voiceId: "v" },
        tts: {
          name: "slow-voice-primary",
          async *synthesize(text) {
            for await (const _ of text) await new Promise(() => {}); // never produces audio
            yield Buffer.alloc(0);
          },
          listVoices: async () => [],
        },
      };
      async function* text() {
        yield "hello.";
      }
      const out: string[] = [];
      const reply = (async () => {
        for await (const pcm of speakWithFallback(stuck, secondary, text(), new AbortController().signal, () => {})) {
          out.push(pcm.toString());
        }
      })();
      await vi.advanceTimersByTimeAsync(5_001);
      await reply;
      expect(out).toEqual(["slow-voice-secondary:hello."]);
    } finally {
      vi.useRealTimers();
    }
  });
});
