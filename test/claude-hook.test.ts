import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lastAssistantText, lastUserText } from "../scripts/claude-memory-hook.mjs";

const HOOK = join(process.cwd(), "scripts", "claude-memory-hook.mjs");

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function gateway(reply: (path: string) => object) {
  const seen: { path: string; auth?: string; body: any }[] = [];
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    seen.push({ path: req.url!, auth: req.headers.authorization, body: JSON.parse(raw || "{}") });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: 0, data: reply(req.url!) }));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function runHook(mode: string, input: object, env: Record<string, string>): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, mode], {
      env: { PATH: process.env.PATH ?? "", MEMORY_ENV_FILE: join(tmpdir(), "no-such.env"), ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => resolve({ stdout, code }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("claude memory hook", () => {
  it("recall adds a few relevant memories to the prompt's context", async () => {
    const gw = await gateway((path) =>
      path.endsWith("atomic/search")
        ? { items: [{ content: "Matthew uses Postgres for every project", score: 0.9 }] }
        : { messages: [{ content: "we decided on Postgres last week", score: 0.5 }, { content: "x".repeat(1000), score: 0.4 }] },
    );
    const { stdout, code } = await runHook("recall", { prompt: "which database should this new project use?" }, { MEMORY_URL: gw.url, MEMORY_API_KEY: "k1", MEMORY_AGENT_ID: "claude" });
    expect(code).toBe(0);
    expect(stdout).toContain("<shared-memory");
    expect(stdout).toContain("Matthew uses Postgres for every project");
    expect(stdout.length).toBeLessThan(1500); // bounded: a few short lines
    expect(gw.seen[0]).toMatchObject({ auth: "Bearer k1", body: { agent_id: "claude", team_id: "default" } });
  });

  it("recall prints nothing when nothing matches, the prompt is trivial, or memory isn't configured", async () => {
    const gw = await gateway(() => ({ items: [], messages: [] }));
    expect((await runHook("recall", { prompt: "which database should this project use?" }, { MEMORY_URL: gw.url })).stdout).toBe("");
    expect((await runHook("recall", { prompt: "ok" }, { MEMORY_URL: gw.url })).stdout).toBe("");
    expect(gw.seen).toHaveLength(2); // only the real prompt searched (facts + conversation)
    expect(await runHook("recall", { prompt: "which database should this project use?" }, {})).toEqual({ stdout: "", code: 0 });
  });

  it("never fails a prompt when the server is down", async () => {
    expect(await runHook("recall", { prompt: "which database should this project use?" }, { MEMORY_URL: "http://127.0.0.1:9" })).toEqual({ stdout: "", code: 0 });
  });

  it("capture saves the last user prompt and assistant reply from the transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-"));
    const transcript = join(dir, "t.jsonl");
    writeFileSync(
      transcript,
      [
        { type: "user", message: { content: "set up the database" } },
        { type: "assistant", message: { content: [{ type: "text", text: "Which one?" }] } },
        { type: "user", message: { content: [{ type: "text", text: "use Postgres please" }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } },
        { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "Done: Postgres is set up." }] } },
      ].map((l) => JSON.stringify(l)).join("\n"),
    );
    const gw = await gateway(() => ({}));
    await runHook("capture", { session_id: "abc", transcript_path: transcript }, { MEMORY_URL: gw.url });
    expect(gw.seen).toHaveLength(1);
    expect(gw.seen[0]!.path).toBe("/v3/conversation/add");
    expect(gw.seen[0]!.body.session_id).toBe("claude-abc");
    expect(gw.seen[0]!.body.messages.map((m: any) => `${m.role}: ${m.content}`)).toEqual(["user: use Postgres please", "assistant: Done: Postgres is set up."]);
  });

  it("reads transcripts: skips tool-only turns and system reminders", () => {
    const t = [
      { type: "user", message: { content: "real question" } },
      { type: "user", message: { content: "<system-reminder>noise</system-reminder>" } },
      { type: "assistant", message: { content: [{ type: "text", text: "answer" }, { type: "tool_use" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use" }] } },
    ].map((l) => JSON.stringify(l)).join("\n");
    expect(lastUserText(t)).toBe("real question");
    expect(lastAssistantText(t)).toBe("answer");
  });
});
