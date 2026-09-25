import { describe, expect, it } from "vitest";
import { chunkSentences } from "../src/orchestrator/sentences.js";
import { SampleAligner, discordToStt, monoToStereo, resampleMono } from "../src/audio/pcm.js";
import { AsyncQueue } from "../src/util/async-queue.js";

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

async function* tokens(...parts: string[]) {
  yield* parts;
}

describe("chunkSentences", () => {
  it("emits each sentence as soon as it is complete", async () => {
    const out = await collect(chunkSentences(tokens("Hi there", ". How are", " you? I'm", " fine.")));
    expect(out).toEqual(["Hi there.", "How are you?", "I'm fine."]);
  });

  it("cuts a long first sentence at a clause to start speaking sooner", async () => {
    const out = await collect(
      chunkSentences(tokens("So the build is running right now on your workstation, and it should finish soon.")),
    );
    expect(out[0]).toBe("So the build is running right now on your workstation,");
    expect(out[1]).toBe("and it should finish soon.");
  });

  it("does not split decimals and strips markdown", async () => {
    const out = await collect(chunkSentences(tokens("Version **3.5** is out. ", "Done")));
    expect(out).toEqual(["Version 3.5 is out.", "Done"]);
  });
});

describe("pcm", () => {
  it("downmixes 48k stereo to 16k mono", () => {
    const stereo = Buffer.alloc(6 * 4); // 6 frames -> 2 output samples
    for (let i = 0; i < 6; i++) {
      stereo.writeInt16LE(300, i * 4);
      stereo.writeInt16LE(100, i * 4 + 2);
    }
    const mono = discordToStt(stereo);
    expect(mono.length).toBe(4);
    expect(mono.readInt16LE(0)).toBe(200);
  });

  it("duplicates mono into both stereo channels", () => {
    const mono = Buffer.alloc(2);
    mono.writeInt16LE(-1234, 0);
    const stereo = monoToStereo(mono);
    expect([stereo.readInt16LE(0), stereo.readInt16LE(2)]).toEqual([-1234, -1234]);
  });

  it("resamples 24k to 48k by doubling length", () => {
    expect(resampleMono(Buffer.alloc(200), 24_000, 48_000).length).toBe(400);
  });

  it("keeps odd byte splits aligned to whole samples", () => {
    const aligner = new SampleAligner(2);
    expect(aligner.push(Buffer.from([1, 2, 3])).length).toBe(2);
    expect(aligner.push(Buffer.from([4])).length).toBe(2);
  });
});

describe("AsyncQueue", () => {
  it("delivers pushed items then ends", async () => {
    const q = new AsyncQueue<number>();
    setTimeout(() => {
      q.push(1);
      q.push(2);
      q.end();
    }, 5);
    expect(await collect(q)).toEqual([1, 2]);
  });

  it("surfaces failures to the consumer", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.fail(new Error("boom"));
    await expect(collect(q)).rejects.toThrow("boom");
  });
});
