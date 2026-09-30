/**
 * `npm run clone-voice -- <name> <audio file or folder>...` — turn voice clips into a
 * cloned voice for the local Qwen3-TTS service.
 *
 * Converts the clips with ffmpeg, transcribes them with Deepgram, picks the longest
 * stretch of continuous speech (up to 15s) and writes services/qwen-tts/voices/<name>.wav
 * plus its transcript. The service picks it up without a restart; add a profile to
 * config/voices.yaml to switch to it (`/voice` in Discord).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { loadEnv } from "../config.js";

const MAX_SECONDS = 15; // longer references slow every sentence down (they're in the prompt)
const MIN_SECONDS = 5;
const MAX_GAP = 1.0; // don't bridge long pauses; they come out as dead air in the clone
const OUT_DIR = "services/qwen-tts/voices";
const AUDIO = new Set([".mp4", ".m4a", ".mp3", ".wav", ".ogg", ".opus", ".webm", ".flac", ".aac"]);

interface Utterance {
  start: number;
  end: number;
  transcript: string;
}

interface Window {
  file: string;
  start: number;
  end: number;
  text: string;
}

const [name, ...inputs] = process.argv.slice(2);
if (!name || !inputs.length || !/^[a-z0-9_-]+$/i.test(name)) {
  console.error("usage: npm run clone-voice -- <name (letters, digits, - or _)> <audio file or folder>...");
  process.exit(1);
}

const env = loadEnv();
if (!env.DEEPGRAM_API_KEY) throw new Error("clone-voice needs DEEPGRAM_API_KEY in .env to transcribe the clips");

const files = inputs.flatMap((input) => {
  const path = resolve(input);
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .filter((f) => AUDIO.has(extname(f).toLowerCase()))
    .map((f) => join(path, f));
});
if (!files.length) throw new Error("no audio files found");

const tmp = mkdtempSync(join(tmpdir(), "clone-voice-"));
const ffmpeg = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

async function transcribe(wav: string): Promise<Utterance[]> {
  const params = new URLSearchParams({ model: "nova-3", smart_format: "true", utterances: "true", utt_split: "0.6" });
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, "Content-Type": "audio/wav" },
    body: readFileSync(wav),
  });
  if (!res.ok) throw new Error(`Deepgram HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { results: { utterances?: Utterance[] } };
  return body.results.utterances ?? [];
}

/** Longest run of consecutive utterances with no long pause, capped at MAX_SECONDS. */
function bestWindow(file: string, utts: Utterance[]): Window | undefined {
  let best: Window | undefined;
  for (let i = 0; i < utts.length; i++) {
    for (let j = i; j < utts.length; j++) {
      if (j > i && utts[j].start - utts[j - 1].end > MAX_GAP) break;
      if (utts[j].end - utts[i].start > MAX_SECONDS) break;
      const length = utts[j].end - utts[i].start;
      if (!best || length > best.end - best.start) {
        const text = utts.slice(i, j + 1).map((u) => u.transcript).join(" ");
        best = { file, start: utts[i].start, end: utts[j].end, text };
      }
    }
  }
  return best;
}

try {
  let best: Window | undefined;
  for (const file of files) {
    const wav = join(tmp, `${basename(file, extname(file))}.wav`);
    ffmpeg("-i", file, "-ac", "1", "-ar", "24000", wav);
    const window = bestWindow(wav, await transcribe(wav));
    const length = window ? (window.end - window.start).toFixed(1) : "0";
    console.log(`${basename(file)}: best stretch ${length}s`);
    if (window && (!best || window.end - window.start > best.end - best.start)) best = window;
  }
  if (!best || best.end - best.start < MIN_SECONDS) {
    throw new Error(`need at least ${MIN_SECONDS}s of continuous speech; add longer or cleaner clips`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, `${name.toLowerCase()}.wav`);
  const start = Math.max(0, best.start - 0.1);
  ffmpeg("-i", best.file, "-ss", start.toFixed(2), "-to", (best.end + 0.25).toFixed(2), out);
  writeFileSync(out.replace(/\.wav$/, ".txt"), best.text + "\n");

  console.log(`\nwrote ${out} (${(best.end - best.start).toFixed(1)}s from ${basename(best.file)})`);
  console.log(`transcript: ${best.text}`);
  console.log(`\nAdd to config/voices.yaml under profiles, then pick it with /voice in Discord:\n`);
  console.log(`  ${name.toLowerCase()}:\n    provider: qwen-local\n    voiceId: ${name.toLowerCase()}\n    language: English`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
