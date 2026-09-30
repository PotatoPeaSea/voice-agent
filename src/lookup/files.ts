import { execFile } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Folders never worth walking into. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache",
  "dist", "build", "out", ".next", ".nuxt", "target", ".cache", ".turbo", "coverage", ".idea", ".vs",
]);
/** Files that hold credentials: never read, searched or sent to the model. */
const SECRET_NAME = /^(\.env(?!\.(example|sample|template)$)(\..+)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|auth\.json|credentials(\..+)?)$/i;
const SECRET_EXT = /\.(pem|key|pfx|p12|jks|keystore|kdbx)$/i;

const MAX_READ_CHARS = 4000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_LIST = 200;
const MAX_FOUND = 100;
const MAX_MATCHES = 40;
const MAX_WALKED = 20_000;
const SEARCH_BUDGET_MS = 8_000;

export function isSecretFile(path: string): boolean {
  const name = basename(path);
  return SECRET_NAME.test(name) || SECRET_EXT.test(name);
}

/** Folder names as speech recognition might mangle them: case, spaces, dashes and underscores ignored. */
const loose = (name: string) => name.toLowerCase().replace(/[\s_-]+/g, "");

/**
 * Read-only access to the allowed project roots for the voice model's lookup tools.
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
      if (real && (await this.inside(real))) return real;
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
        if (!SKIP_DIRS.has(entry.name)) pending.push(full);
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
