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
    const cfg = loadVoices();
    expect(cfg.profiles[cfg.active]).toBeDefined();
  });
});

describe("switching the active voice", () => {
  it("rewrites only the active line", async () => {
    const { withActive } = await import("../src/speech/voices.js");
    const yaml = "# keep me\nactive: a # comment\nprofiles:\n  a: { provider: p, voiceId: v }\n  b: { provider: p, voiceId: w }\n";
    expect(withActive(yaml, "b")).toBe("# keep me\nactive: b\nprofiles:\n  a: { provider: p, voiceId: v }\n  b: { provider: p, voiceId: w }\n");
  });
});
