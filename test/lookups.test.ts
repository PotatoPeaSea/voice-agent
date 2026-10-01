import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { inSecretFolder, isSecretFile, Workspace } from "../src/lookup/files.js";
import { FolderTools, LookupTools } from "../src/orchestrator/lookup-tools.js";

let base: string;
let root: string;
let ws: Workspace;
let tools: LookupTools;
const ctx = { userTranscript: "" };

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "lookups-"));
  root = join(base, "root");
  const project = join(root, "Voice Agent");
  mkdirSync(join(project, "src", "deep"), { recursive: true });
  mkdirSync(join(project, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(project, "src", "main.ts"), "const greeting = 'hello';\nexport function start() {}\n");
  writeFileSync(join(project, "src", "deep", "util.test.ts"), "it('works', () => {});\n// TODO: more\n");
  writeFileSync(join(project, "node_modules", "dep", "index.js"), "// TODO: hidden in deps\n");
  writeFileSync(join(project, "README.md"), Array.from({ length: 400 }, (_, i) => `line ${i + 1} ${"x".repeat(30)}`).join("\n"));
  writeFileSync(join(project, ".env"), "SECRET=hunter2 TODO\n");
  writeFileSync(join(project, ".env.example"), "SECRET=\n");
  writeFileSync(join(project, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  writeFileSync(join(base, "outside.txt"), "not yours");
  mkdirSync(join(root, "Other"));
  mkdirSync(join(root, ".ssh"));
  writeFileSync(join(root, ".ssh", "config"), "Host potato\n");
  ws = new Workspace([root]);
  tools = new LookupTools(ws);
});

const call = async (name: string, args: object) => tools.execute(name, JSON.stringify(args), ctx) as Promise<Record<string, any>>;

describe("Workspace paths", () => {
  it("resolves project names loosely, as speech recognition mangles them", async () => {
    expect(await ws.resolve("voice-agent/src/main.ts")).toBe(join(root, "Voice Agent", "src", "main.ts"));
    expect(await ws.resolve("VoiceAgent")).toBe(join(root, "Voice Agent"));
    expect(await ws.resolve(join(root, "Voice Agent", "src"))).toBe(join(root, "Voice Agent", "src"));
  });

  it("refuses paths outside the roots, however they're written", async () => {
    await expect(ws.resolve("../outside.txt")).rejects.toThrow(/inside the allowed folders/);
    await expect(ws.resolve(join(base, "outside.txt"))).rejects.toThrow(/inside the allowed folders/);
    await expect(ws.resolve("Voice Agent/../../outside.txt")).rejects.toThrow(/inside the allowed folders/);
    await expect(ws.resolve("Voice Agent/nope.ts")).rejects.toThrow(/existing path/);
  });

  it("treats credential files as secret but not their examples", () => {
    for (const name of [".env", ".env.local", "id_rsa", "server.pem", "credentials.json", ".credentials.json", "auth.json", ".git-credentials"]) {
      expect(isSecretFile(name)).toBe(true);
    }
    for (const name of [".env.example", "main.ts", "environment.ts", "README.md"]) expect(isSecretFile(name)).toBe(false);
  });

  it("keeps key folders like .ssh off limits", async () => {
    expect(inSecretFolder(join("home", ".ssh", "config"))).toBe(true);
    expect(inSecretFolder(join("home", "Documents", "ssh-notes"))).toBe(false);
    await expect(ws.resolve(".ssh/config")).rejects.toThrow(/off limits/);
  });
});

describe("create_folder", () => {
  // Its own folders, so what it creates (and the link) can't upset the other tests.
  let out: string;
  let top: string;
  let folders: FolderTools;
  const create = async (path: string) => folders.execute("create_folder", JSON.stringify({ path })) as Promise<Record<string, any>>;

  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "folders-"));
    top = join(out, "root");
    mkdirSync(join(top, "Voice Agent"), { recursive: true });
    mkdirSync(join(top, ".ssh"));
    writeFileSync(join(top, "Voice Agent", "README.md"), "hi\n");
    folders = new FolderTools(new Workspace([top]));
  });

  it("creates a folder and missing parents, matching spoken project names loosely", async () => {
    expect(await create("voice agent/notes/ideas")).toMatchObject({ created: true, folder: join("Voice Agent", "notes", "ideas") });
    expect(statSync(join(top, "Voice Agent", "notes", "ideas")).isDirectory()).toBe(true);
    expect(await create(join(top, "Brand New"))).toMatchObject({ created: true, full_path: join(top, "Brand New") });
    expect(await create("Voice Agent")).toMatchObject({ created: false });
  });

  it("refuses paths outside the roots, bad names, files and key folders", async () => {
    expect((await create("../escaped")).error).toMatch(/inside the allowed folders/);
    expect((await create(join(out, "elsewhere", "x"))).error).toMatch(/inside the allowed folders/);
    expect((await create("Voice Agent/../../escaped")).error).toMatch(/can't be used/);
    expect((await create("Voice Agent/what?")).error).toMatch(/can't be used/);
    expect((await create("Voice Agent/README.md/sub")).error).toMatch(/is a file/);
    expect((await create(".ssh/stash")).error).toMatch(/off limits/);
    expect(existsSync(join(out, "escaped")) || existsSync(join(out, "elsewhere"))).toBe(false);
  });

  it("won't follow a link that leads outside the roots", async () => {
    try {
      symlinkSync(out, join(top, "link"), "junction");
    } catch {
      return; // no permission to make links here
    }
    expect((await create("link/sneaky")).error).toMatch(/outside|inside the allowed/);
    expect((await create("Voice Agent/../link/sneaky")).error).toBeDefined();
    expect(existsSync(join(out, "sneaky"))).toBe(false);
  });
});

describe("lookup tools", () => {
  it("list_files lists the roots, a folder, or files by name", async () => {
    expect(await call("list_files", {})).toEqual([{ root, projects: ["Other", "Voice Agent"] }]);
    const folder = await call("list_files", { path: "Voice Agent" });
    expect(folder.entries.slice(0, 2)).toEqual(["node_modules/", "src/"]);
    expect(folder.entries).toContain("README.md");
    expect((await call("list_files", { path: "Voice Agent", name: "*.test.ts" })).found).toEqual([join("src", "deep", "util.test.ts")]);
    expect((await call("list_files", { path: "Voice Agent", name: "src/**" })).found).toHaveLength(2);
    expect((await call("list_files", { path: "Voice Agent", name: "MAIN" })).found).toEqual([join("src", "main.ts")]);
  });

  it("read_file pages through long files and refuses secrets and binaries", async () => {
    const first = await call("read_file", { path: "Voice Agent/README.md" });
    expect(first).toMatchObject({ file: join("Voice Agent", "README.md"), lines: 400, from_line: 1 });
    expect(first.content.length).toBeLessThanOrEqual(4000);
    const next = await call("read_file", { path: "Voice Agent/README.md", from_line: first.next_from_line });
    expect(next.content.startsWith(`line ${first.next_from_line} `)).toBe(true);
    expect((await call("read_file", { path: "Voice Agent/.env" })).error).toMatch(/credentials/);
    expect((await call("read_file", { path: "Voice Agent/.env.example" })).content).toContain("SECRET=");
    expect((await call("read_file", { path: "Voice Agent/logo.png" })).error).toMatch(/binary/);
  });

  it("search_files skips dependencies and secrets", async () => {
    const result = await call("search_files", { pattern: "todo", path: "Voice Agent" });
    expect(result.matches).toEqual([{ file: join("src", "deep", "util.test.ts"), line: 2, text: "// TODO: more" }]);
    expect((await call("search_files", { pattern: "start(", path: "Voice Agent", files: "*.ts" })).matches).toHaveLength(1);
    const oneFile = await call("search_files", { pattern: "greeting|start", path: "Voice Agent/src/main.ts" });
    expect(oneFile.matches.map((m: { line: number }) => m.line)).toEqual([1, 2]);
    expect((await call("search_files", { pattern: "SECRET", path: "Voice Agent/.env" })).matches).toEqual([]);
  });

  it("git_info reports branch, changes and commits", async () => {
    const repo = join(root, "Other");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "first commit");
    writeFileSync(join(repo, "b.txt"), "b");
    const info = await call("git_info", { path: "other" });
    expect(info.branch).toBe("main");
    expect(info.uncommitted_changes).toEqual(["?? b.txt"]);
    expect(info.recent_commits[0]).toMatch(/^[0-9a-f]+ .*: first commit$/);
    expect((await call("git_info", { path: "Voice Agent" })).error).toMatch(/isn't a git repository/);
  });

  it("current_time and bad arguments", async () => {
    expect(await call("current_time", {})).toHaveProperty("time_zone");
    expect(await tools.execute("read_file", "{nope", ctx)).toHaveProperty("error");
  });
});
