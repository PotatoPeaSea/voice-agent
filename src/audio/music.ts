import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".opus", ".flac", ".m4a", ".aac", ".webm"]);
const FADE_IN_S = 1.5;

/**
 * Hold music from an audio file or a folder of them, decoded with ffmpeg to
 * 48kHz stereo PCM. The folder is rescanned on every play, so tracks can be
 * added while the bot runs. Anything missing (path, files, ffmpeg) just means
 * no music, logged once.
 */
export class MusicLibrary {
  private readonly path: string;
  private readonly bad = new Set<string>();
  private ffmpegMissing = false;
  private warned = false;

  constructor(
    path: string,
    private readonly volume: number,
    private readonly log: (...a: unknown[]) => void,
    private readonly ffmpeg = "ffmpeg",
  ) {
    this.path = resolve(path);
  }

  /** Playable tracks right now. */
  tracks(): string[] {
    if (this.ffmpegMissing) return [];
    const found = findAudio(this.path).filter((f) => !this.bad.has(f));
    if (!found.length && !this.warned) {
      this.warned = true;
      this.log(`hold music off: no audio files at ${this.path}`);
    }
    if (found.length) this.warned = false;
    return found;
  }

  /** Shuffled tracks on repeat until the signal aborts (or nothing will play). */
  async *play(signal: AbortSignal): AsyncIterable<Buffer> {
    while (!signal.aborted) {
      const tracks = shuffle(this.tracks());
      let played = false;
      for (const track of tracks) {
        if (signal.aborted) return;
        for await (const pcm of this.decode(track, signal)) {
          played = true;
          yield pcm;
        }
      }
      if (!played) return;
    }
  }

  private async *decode(file: string, signal: AbortSignal): AsyncIterable<Buffer> {
    const args = ["-hide_banner", "-loglevel", "error", "-i", file, "-vn"];
    args.push("-af", `volume=${this.volume},afade=t=in:d=${FADE_IN_S}`, "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1");
    const child = spawn(this.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-500)));
    const exited = new Promise<number | Error | null>((done) => {
      child.once("error", done);
      child.once("close", done);
    });
    const kill = () => child.kill();
    signal.addEventListener("abort", kill, { once: true });
    let bytes = 0;
    try {
      for await (const chunk of child.stdout) {
        bytes += (chunk as Buffer).length;
        yield chunk as Buffer;
      }
    } finally {
      signal.removeEventListener("abort", kill);
      child.kill();
    }
    const result = await exited;
    if (signal.aborted) return;
    if (result instanceof Error) {
      this.ffmpegMissing = true;
      this.log(`hold music off: couldn't run ffmpeg (${result.message})`);
    } else if (!bytes) {
      this.bad.add(file);
      this.log(`hold music: skipping ${file} (${stderr.trim().split("\n").at(-1) || `ffmpeg exited ${result}`})`);
    }
  }
}

/** Audio files at a path: the file itself, or those directly inside a folder (sorted). */
export function findAudio(path: string): string[] {
  if (!existsSync(path)) return [];
  const isAudio = (f: string) => EXTENSIONS.has(extname(f).toLowerCase());
  try {
    if (!statSync(path).isDirectory()) return isAudio(path) ? [path] : [];
    return readdirSync(path)
      .filter(isAudio)
      .sort()
      .map((f) => join(path, f));
  } catch {
    return [];
  }
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
