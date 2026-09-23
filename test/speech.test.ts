import { describe, expect, it } from "vitest";
import { createTts, registerTts } from "../src/speech/registry.js";
import { parseVoices } from "../src/speech/voices.js";

describe("speech registry", () => {
  it("creates a registered provider and rejects unknown ones", () => {
    registerTts("fake", () => ({
      name: "fake",
      async *synthesize() {},
      listVoices: async () => [],
    }));
    expect(createTts("fake").name).toBe("fake");
    expect(() => createTts("nope")).toThrow(/Unknown TTS provider "nope"/);
  });
});

describe("voice profiles", () => {
  it("parses profiles and passes providerOptions through", () => {
    const cfg = parseVoices(`
active: a
profiles:
  a: { provider: elevenlabs, voiceId: v1, providerOptions: { stability: 0.4 } }
`);
    expect(cfg.profiles.a.providerOptions).toEqual({ stability: 0.4 });
  });

  it("rejects an active profile that does not exist", () => {
    expect(() => parseVoices("active: x\nprofiles: {}\n")).toThrow(/Active voice "x"/);
  });

  it("parses the shipped config/voices.yaml", async () => {
    const { loadVoices } = await import("../src/speech/voices.js");
    expect(loadVoices().active).toBe("default");
  });
});
