import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBrief, parseReport } from "../src/tasks/report.js";
import { trimHistory } from "../src/orchestrator/session.js";
import { TaskTools } from "../src/orchestrator/tools.js";
import { TaskRegistry } from "../src/tasks/registry.js";
import type { Task, TaskSettings } from "../src/tasks/types.js";
import type { WorkerAdapter } from "../src/workers/types.js";
import type { ChatMessage } from "../src/llm/chat.js";

describe("reports", () => {
  it("splits the voice summary into headline and bullets", () => {
    const report = parseReport("Lots of detail here.\n\nVOICE SUMMARY: Fixed the login bug.\n- Patched auth.ts\n- Tests pass");
    expect(report.headline).toBe("Fixed the login bug.");
    expect(report.bullets).toEqual(["Patched auth.ts", "Tests pass"]);
    expect(report.full).toContain("Lots of detail");
  });

  it("strips markdown the agent wraps around the summary", () => {
    const report = parseReport("Done.\n\n**VOICE SUMMARY:** Counted **33** files.\n- `src/a.ts` is largest");
    expect(report.headline).toBe("Counted 33 files.");
    expect(report.bullets).toEqual(["src/a.ts is largest"]);
  });

  it("falls back to the first sentence without a summary marker", () => {
    expect(parseReport("All done. Other stuff.").headline).toBe("All done.");
  });

  it("puts the verbatim transcript and report format in the brief", () => {
    const brief = buildBrief({ goal: "Run the tests", cwd: "/p", userTranscript: "run the tests please" });
    expect(brief).toContain('"run the tests please"');
    expect(brief).toContain("VOICE SUMMARY:");
  });
});

describe("trimHistory", () => {
  it("never leaves a tool result without its tool call", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", content: "{}" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "b" },
      { role: "assistant", content: "c" },
    ];
    trimHistory(history, 4);
    expect(history[0]).toEqual({ role: "user", content: "b" });
  });
});

class FakeWorker implements WorkerAdapter {
  readonly name = "fake";
  started: { task: Task; prompt: string }[] = [];
  async start(task: Task, prompt: string) {
    this.started.push({ task, prompt });
  }
  async send() {}
  async configure(_task: Task, settings: TaskSettings) {
    return { settings, ignored: [] };
  }
  answerPermission() {}
  async cancel() {}
  async settings() {
    return [];
  }
  shutdown() {}
}

describe("TaskTools", () => {
  const root = mkdtempSync(join(tmpdir(), "roots-"));
  mkdirSync(join(root, "Voice Agent"));
  const worker = new FakeWorker();
  const tools = new TaskTools(new TaskRegistry(), worker, [root]);

  it("resolves spoken project names case- and space-insensitively", () => {
    expect(tools.resolveProject("voice agent")).toBe(join(root, "Voice Agent"));
    expect(tools.resolveProject("VoiceAgent")).toBe(join(root, "Voice Agent"));
  });

  it("refuses folders outside the allowed roots", () => {
    expect(() => tools.resolveProject("..")).toThrow(/not a folder inside/);
    expect(() => tools.resolveProject(tmpdir())).toThrow(/not a folder inside/);
  });

  it("dispatches with settings and the user's words", async () => {
    const result = (await tools.execute(
      "dispatch_task",
      JSON.stringify({ title: "Tests", goal: "Run tests", project: "voice agent", model: "haiku", effort: "low" }),
      { userTranscript: "hey run the tests" },
    )) as { task_id: string };
    expect(result.task_id).toMatch(/^t\d+$/);
    const [started] = worker.started;
    expect(started.task.settings).toEqual({ model: "haiku", effort: "low" });
    expect(started.prompt).toContain("hey run the tests");
  });

  it("returns errors to the model instead of throwing", async () => {
    expect(await tools.execute("get_task", '{"task_id":"t99"}', { userTranscript: "" })).toEqual({
      error: 'No task "t99". Use list_tasks.',
    });
  });
});
