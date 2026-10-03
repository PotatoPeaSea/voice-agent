import { execFile } from "node:child_process";
import { appendFile, lstat, mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Folders never worth walking into. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache",
  "dist", "build", "out", ".next", ".nuxt", "target", ".cache", ".turbo", "coverage", ".idea", ".vs",
]);
/** Files that hold credentials: never read, searched or sent to the model. */
const SECRET_NAME = /^(\.env(?!\.(example|sample|template)$)(\..+)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|auth\.json|\.?credentials(\..+)?)$/i;
/** Folders of keys and cloud logins (now that the home folder may be a root): nothing inside is reachable. */
const SECRET_DIRS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", "gcloud"]);
const SECRET_EXT = /\.(pem|key|pfx|p12|jks|keystore|kdbx)$/i;

const MAX_READ_CHARS = 4000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_LIST = 200;
const MAX_FOUND = 100;
const MAX_MATCHES = 40;
const MAX_WALKED = 20_000;
const SEARCH_BUDGET_MS = 8_000;
const MAX_WRITE_CHARS = 20_000;

/** How write_file changes a file: add lines to the end, make a new one, or replace all its text. */
export const WRITE_MODES = ["append", "create", "replace"] as const;
export type WriteMode = (typeof WRITE_MODES)[number];

export function isSecretFile(path: string): boolean {
  const name = basename(path);
  return SECRET_NAME.test(name) || SECRET_EXT.test(name);
}

/** A path inside one of the SECRET_DIRS. */
export function inSecretFolder(path: string): boolean {
  return path.split(/[\\/]/).some((part) => SECRET_DIRS.has(part.toLowerCase()));
}

/** Characters Windows refuses in a file or folder name. */
const BAD_NAME = /[<>:"|?*\u0000-\u001f]|[. ]$/;

/** Line ending for files the voice model creates (existing files keep their own). */
const DEFAULT_EOL = process.platform === "win32" ? "\r\n" : "\n";

/** Folder names as speech recognition might mangle them: case, spaces, dashes and underscores ignored. */
const loose = (name: string) => name.toLowerCase().replace(/[\s_-]+/g, "");

/**
 * Access to the allowed roots for the voice model's file tools: reading, plus creating folders and writing text files.
 * Every path is resolved (symlinks included) and refused if it lands outside the roots.
 */
export class Workspace {
  readonly roots: string[];

  constructor(roots: string[]) {
    this.roots = roots.map((r) => resolve(r));
  }

  /** An absolute path inside the roots, from an absolute path, a root-relative one, or a spoken project name. */
  async resolve(path: string): Promise<string> {
    const wanted = path.trim().replace(/[\\/]+/g, sep);
    if (!wanted) throw new Error("path is empty");
    const candidates = isAbsolute(wanted) ? [resolve(wanted)] : this.roots.map((root) => resolve(root, wanted));
    if (!isAbsolute(wanted)) {
      // "voice agent/src" -> "Voice Agent/src": match the first segment loosely against real folder names.
      const [first, ...rest] = wanted.split(sep);
      for (const root of this.roots) {
        for (const name of await readdir(root).catch(() => [] as string[])) {
          if (loose(name) === loose(first!)) candidates.push(join(root, name, ...rest));
        }
      }
    }
    for (const candidate of candidates) {
      const real = await realpath(candidate).catch(() => undefined);
      if (real && (await this.inside(real))) {
        if (inSecretFolder(this.display(real))) throw new Error(`"${path}" is in a folder of keys or logins, so it's off limits.`);
        return real;
      }
    }
    throw new Error(`"${path}" isn't an existing path inside the allowed folders (${this.roots.join(", ")}). Use list_files to look around.`);
  }

  private async inside(path: string): Promise<boolean> {
    for (const root of this.roots) {
      const rel = relative(await realpath(root).catch(() => root), path);
      if (!rel.startsWith("..") && !isAbsolute(rel)) return true;
    }
    return false;
  }

  /** A path as the model should see it: relative to its root when possible. */
  display(path: string): string {
    for (const root of this.roots) {
      const rel = relative(root, path);
      if (!rel.startsWith("..") && !isAbsolute(rel)) return rel || root;
    }
    return path;
  }

  /**
   * Create a folder (and any missing parents) inside the roots. The path is resolved like resolve(),
   * except its last parts may not exist yet. Returns where it is, and whether it was already there.
   */
  async createFolder(path: string): Promise<{ folder: string; full_path: string; created: boolean }> {
    const wanted = path.trim().replace(/[\\/]+/g, sep).replace(/[\\/]+$/, "");
    if (!wanted) throw new Error("path is empty");
    if (inSecretFolder(wanted)) throw new Error(`"${path}" is in a folder of keys or logins, so it's off limits.`);
    // The longest existing part of the path that's inside the roots, then the parts still to create.
    const absolute = isAbsolute(wanted);
    const top = absolute ? parse(resolve(wanted)).root : "";
    const parts = (absolute ? relative(top, resolve(wanted)) : wanted).split(sep).filter(Boolean);
    for (let i = parts.length; i >= (absolute ? 0 : 1); i--) {
      let existing: string;
      try {
        existing = await this.resolve(absolute ? join(top, ...parts.slice(0, i)) : parts.slice(0, i).join(sep));
      } catch {
        continue;
      }
      if (!(await stat(existing)).isDirectory()) throw new Error(`"${this.display(existing)}" is a file, not a folder.`);
      const rest = parts.slice(i);
      if (!rest.length) return { folder: this.display(existing), full_path: existing, created: false };
      const bad = rest.find((part) => part === ".." || part === "." || BAD_NAME.test(part));
      if (bad) throw new Error(`"${bad}" can't be used in a folder name.`);
      // The next part exists but didn't resolve: it leads outside the roots (e.g. a symlink).
      if (await lstat(join(existing, rest[0]!)).then(() => true, () => false)) {
        throw new Error(`"${this.display(join(existing, rest[0]!))}" leads outside the allowed folders.`);
      }
      const target = join(existing, ...rest);
      if (inSecretFolder(this.display(target))) throw new Error(`"${path}" is in a folder of keys or logins, so it's off limits.`);
      await mkdir(target, { recursive: true });
      return { folder: this.display(target), full_path: target, created: true };
    }
    throw new Error(`"${path}" isn't inside the allowed folders (${this.roots.join(", ")}). Use list_files to look around.`);
  }

  /**
   * Write text to a file inside the roots: "append" adds it as new lines at the end of an existing file,
   * "create" makes a new file in an existing folder, "replace" swaps an existing file's whole text.
   * Never deletes, never touches binaries or credential files, and keeps an existing file's line endings.
   */
  async writeFile(path: string, text: string, mode: WriteMode): Promise<{ file: string; full_path: string; mode: WriteMode; lines: number }> {
    if (!WRITE_MODES.includes(mode)) throw new Error(`mode must be one of: ${WRITE_MODES.join(", ")}.`);
    if (!text.trim()) throw new Error("text is empty");
    if (text.length > MAX_WRITE_CHARS) throw new Error(`text is too long (${text.length} characters, at most ${MAX_WRITE_CHARS}).`);
    const lines = text.replace(/(\r?\n)+$/, "").split(/\r?\n/);
    if (mode === "create") {
      const wanted = path.trim().replace(/[\\/]+/g, sep).replace(/[\\/]+$/, "");
      const name = basename(wanted);
      if (!name || name === ".." || BAD_NAME.test(name)) throw new Error(`"${name}" can't be used as a file name.`);
      if (isSecretFile(name)) throw new Error(`"${name}" would hold credentials, so it can't be written.`);
      const folder = await this.resolve(dirname(wanted));
      if (!(await stat(folder)).isDirectory()) throw new Error(`"${this.display(folder)}" is a file, not a folder.`);
      const target = join(folder, name);
      if (await lstat(target).then(() => true, () => false)) throw new Error(`"${this.display(target)}" already exists; use append or replace.`);
      await writeFile(target, lines.join(DEFAULT_EOL) + DEFAULT_EOL, { encoding: "utf8", flag: "wx" });
      return { file: this.display(target), full_path: target, mode, lines: lines.length };
    }
    const file = await this.resolve(path);
    const info = await stat(file);
    if (info.isDirectory()) throw new Error(`"${this.display(file)}" is a folder; give a file inside it.`);
    if (isSecretFile(file)) throw new Error(`"${basename(file)}" may hold credentials, so it can't be written.`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`"${this.display(file)}" is too large to edit (${Math.round(info.size / 1e6)} MB).`);
    const current = await readText(file, info.size);
    if (current === undefined) throw new Error(`"${this.display(file)}" is a binary file.`);
    const eol = current.includes("\r\n") ? "\r\n" : current.includes("\n") ? "\n" : DEFAULT_EOL;
    const body = lines.join(eol);
    if (mode === "replace") {
      await writeFile(file, body + eol, "utf8");
    } else {
      // Start on a new line, and end with one if the file already did.
      const lead = current && !current.endsWith("\n") ? eol : "";
      const trail = !current || current.endsWith("\n") ? eol : "";
      await appendFile(file, lead + body + trail, "utf8");
    }
    return { file: this.display(file), full_path: file, mode, lines: lines.length };
  }

  /** The roots and their project folders. */
  async projects(): Promise<{ root: string; projects: string[] }[]> {
    return Promise.all(
      this.roots.map(async (root) => {
        const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
        return { root, projects: entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name) };
      }),
    );
  }

  /** A folder's entries (folders end in "/"), or with a pattern, files anywhere below whose name matches it. */
  async list(path: string, pattern?: string, signal?: AbortSignal): Promise<unknown> {
    const dir = await this.resolve(path);
    if (!(await stat(dir)).isDirectory()) throw new Error(`"${path}" is a file; use read_file.`);
    if (pattern?.trim()) {
      const matches = nameMatcher(pattern.trim());
      const found: string[] = [];
      for await (const file of walk(dir, signal)) {
        if (matches(relative(dir, file).split(sep).join("/"))) found.push(relative(dir, file));
        if (found.length >= MAX_FOUND) break;
      }
      return { folder: this.display(dir), pattern, found, ...(found.length >= MAX_FOUND ? { note: `first ${MAX_FOUND} shown` } : {}) };
    }
    const entries = await readdir(dir, { withFileTypes: true });
    const names = entries
      .filter((e) => e.name !== ".git")
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return { folder: this.display(dir), entries: names.slice(0, MAX_LIST), ...(names.length > MAX_LIST ? { more: names.length - MAX_LIST } : {}) };
  }

  /** A text file's content from a line on, cut to a few thousand characters. */
  async read(path: string, fromLine = 1): Promise<unknown> {
    const file = await this.resolve(path);
    const info = await stat(file);
    if (info.isDirectory()) return this.list(path);
    if (isSecretFile(file)) throw new Error(`"${basename(file)}" may hold credentials, so it can't be read.`);
    if (info.size > MAX_FILE_BYTES * 5) throw new Error(`"${path}" is too large to read (${Math.round(info.size / 1e6)} MB).`);
    const text = await readText(file, info.size);
    if (text === undefined) throw new Error(`"${path}" is a binary file.`);
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, Math.floor(fromLine));
    let content = "";
    let end = start - 1;
    while (end < lines.length && content.length + lines[end]!.length < MAX_READ_CHARS) content += `${lines[end++]}\n`;
    if (end === start - 1 && end < lines.length) content = lines[end++]!.slice(0, MAX_READ_CHARS); // one very long line
    return {
      file: this.display(file),
      lines: lines.length,
      from_line: start,
      to_line: end,
      content,
      ...(end < lines.length ? { next_from_line: end + 1 } : {}),
    };
  }

  /** Lines matching a pattern (regex or plain text, case-insensitive) in text files below a folder, or in one file. */
  async search(pattern: string, path: string, filePattern?: string, signal?: AbortSignal): Promise<unknown> {
    const target = await this.resolve(path);
    const single = (await stat(target)).isFile();
    const dir = single ? dirname(target) : target;
    const files = single ? oneFile(target) : walk(dir, signal);
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const wantFile = filePattern?.trim() ? nameMatcher(filePattern.trim()) : () => true;
    const deadline = Date.now() + SEARCH_BUDGET_MS;
    const matches: { file: string; line: number; text: string }[] = [];
    let searched = 0;
    let stopped: string | undefined;
    for await (const file of files) {
      if (Date.now() > deadline) {
        stopped = "took too long; narrow the folder or file pattern";
        break;
      }
      if (isSecretFile(file) || !wantFile(relative(dir, file).split(sep).join("/"))) continue;
      const size = (await stat(file).catch(() => undefined))?.size ?? 0;
      if (!size || size > MAX_FILE_BYTES) continue;
      const text = await readText(file, size);
      if (text === undefined) continue;
      searched++;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
        if (regex.test(lines[i]!)) matches.push({ file: relative(dir, file), line: i + 1, text: lines[i]!.trim().slice(0, 200) });
      }
      if (matches.length >= MAX_MATCHES) {
        stopped = `first ${MAX_MATCHES} matches shown`;
        break;
      }
    }
    return { folder: this.display(dir), pattern, files_searched: searched, matches, ...(stopped ? { note: stopped } : {}) };
  }

  /** Branch, uncommitted changes and recent commits of the repository at a path. */
  async git(path: string, signal?: AbortSignal): Promise<unknown> {
    const dir = await this.resolve(path);
    const git = async (...args: string[]) =>
      (await run("git", ["-c", "core.quotepath=off", ...args], { cwd: dir, timeout: 10_000, signal, windowsHide: true })).stdout.trimEnd();
    let status: string;
    try {
      status = await git("status", "--short", "--branch");
    } catch (err) {
      throw new Error(`"${this.display(dir)}" isn't a git repository (${(err as Error).message.split("\n")[0]})`);
    }
    const [branch, ...changes] = status.split("\n");
    const log = await git("log", "-n", "8", "--format=%h %ar: %s").catch(() => "");
    return {
      repository: this.display(dir),
      branch: branch?.replace(/^## /, ""),
      uncommitted_changes: changes.length > 30 ? [...changes.slice(0, 30), `... ${changes.length - 30} more`] : changes,
      recent_commits: log ? log.split("\n") : [],
    };
  }
}

async function* oneFile(file: string): AsyncGenerator<string> {
  yield file;
}

/** Files below a folder, skipping build/dependency folders and symlinks. */
async function* walk(dir: string, signal?: AbortSignal): AsyncGenerator<string> {
  const pending = [dir];
  let seen = 0;
  while (pending.length) {
    if (signal?.aborted || seen++ > MAX_WALKED) return;
    const current = pending.shift()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !SECRET_DIRS.has(entry.name.toLowerCase())) pending.push(full);
      } else if (entry.isFile()) {
        seen++;
        yield full;
      }
    }
  }
}

/**
 * Match a file by a glob ("*.ts", "src/**\/*.test.ts") or, without wildcards, a
 * case-insensitive piece of its name. Globs with a "/" match the relative path.
 */
function nameMatcher(pattern: string): (relPath: string) => boolean {
  if (!/[*?[]/.test(pattern)) {
    const piece = pattern.toLowerCase();
    return (rel) => rel.toLowerCase().includes(piece);
  }
  const source = pattern
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  const regex = new RegExp(`^${source}$`, "i");
  return pattern.includes("/") ? (rel) => regex.test(rel) : (rel) => regex.test(rel.split("/").pop()!);
}

/** A file's text, or undefined if it looks binary (a NUL byte early on). */
async function readText(file: string, size: number): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, MAX_FILE_BYTES * 5));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, bytesRead);
    if (data.subarray(0, 8000).includes(0)) return undefined;
    return data.toString("utf8");
  } finally {
    await handle.close();
  }
}
