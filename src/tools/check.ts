/**
 * `npm run check` — verify each configured service (keys, models, voice IDs)
 * and measure its latency, without joining Discord.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { loadEnv } from "../config.js";
import { ChatModel } from "../llm/chat.js";
import { getTts, makeStt } from "../speech/index.js";
import { loadVoices } from "../speech/voices.js";
import { sttSilence } from "../audio/pcm.js";
import { pcmToWav } from "../audio/wav.js";
import { AsyncQueue } from "../util/async-queue.js";

const env = loadEnv();
const only = process.argv[2]; // optional: check a single voice profile
let failures = 0;

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    console.log(`✔ ${name} (${Date.now() - t0}ms) ${detail}`);
  } catch (err) {
    failures++;
    console.log(`✘ ${name}: ${(err as Error).message}`);
  }
}

async function* sentences(...items: string[]) {
  yield* items;
}

if (!only) {
  await step(`LLM ${env.LLM_MODEL} @ ${env.LLM_BASE_URL}`, async () => {
    const chat = new ChatModel(env);
    const firstTokenMs: number[] = [];
    let text = "";
    // Twice: the first call includes connection setup, the second shows steady-state latency.
    for (let i = 0; i < 2; i++) {
      const t0 = Date.now();
      text = "";
      for await (const token of chat.stream([{ role: "user", content: "Say hi in five words." }], new AbortController().signal)) {
        if (!text) firstTokenMs.push(Date.now() - t0);
        text += token;
      }
    }
    return `first token cold ${firstTokenMs[0]}ms, warm ${firstTokenMs[1]}ms: "${text.trim()}"`;
  });

  await step(`STT ${env.STT_PROVIDER}`, async () => {
    const controller = new AbortController();
    const audio = new AsyncQueue<Buffer>();
    const events = makeStt(env).transcribe(audio, controller.signal);
    for (let i = 0; i < 10; i++) audio.push(sttSilence(80));
    // Silence produces no turns; the stream only fails if the connection is rejected.
    setTimeout(() => controller.abort(), 4000);
    for await (const _ of events) {
      // drain
    }
    return "streamed 4s without errors";
  });
}

const voices = loadVoices();
for (const [name, profile] of Object.entries(voices.profiles)) {
  if (only && name !== only) continue;
  if (profile.voiceId.startsWith("REPLACE_")) {
    console.log(`- TTS profile "${name}" skipped (no voice ID set)`);
    continue;
  }
  await step(`TTS profile "${name}" (${profile.provider}, voice ${profile.voiceId})`, async () => {
    const tts = getTts(profile.provider, env);
    const t0 = Date.now();
    let first = 0;
    const chunks: Buffer[] = [];
    const text = sentences("Hello! This is a voice check.", "The second sentence should follow smoothly.");
    for await (const pcm of tts.synthesize(text, profile, new AbortController().signal)) {
      first ||= Date.now() - t0;
      chunks.push(pcm);
    }
    const pcm = Buffer.concat(chunks);
    if (!pcm.length) throw new Error("no audio returned");
    mkdirSync("recordings", { recursive: true });
    const file = `recordings/tts-check-${name}.wav`;
    writeFileSync(file, pcmToWav(pcm));
    return `first audio ${first}ms, ${(pcm.length / 192_000).toFixed(1)}s audio in ${Date.now() - t0}ms -> ${file}`;
  });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
