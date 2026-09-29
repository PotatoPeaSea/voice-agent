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
import { matchModel } from "../src/workers/hermes-acp.js";
import { renderStatus } from "../src/bot/reports.js";

const tmpDir = () => mkdtempSync(join(tmpdir(), "tasks-"));

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
  constructor(readonly name = "claude-code") {}
  started: { task: Task; prompt: string }[] = [];
  async start(task: Task, prompt: string) {
    this.started.push({ task, prompt });
  }
  async send(_task: Task, _message: string) {}
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
  const tools = new TaskTools(new TaskRegistry({ dir: tmpDir() }), worker, [root]);

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

  it("routes tasks to the named worker and keeps using it for follow-ups", async () => {
    const claude = new FakeWorker("claude-code");
    const hermes = new FakeWorker("hermes");
    const sent: string[] = [];
    hermes.send = async (task: Task) => {
      sent.push(task.id);
    };
    const routed = new TaskTools(new TaskRegistry({ dir: tmpDir() }), [claude, hermes], [root]);
    const result = (await routed.execute("dispatch_task", JSON.stringify({ worker: "hermes", title: "Research", goal: "Look it up" }), {
      userTranscript: "",
    })) as { task_id: string; worker: string; project: string };
    expect(result.worker).toBe("hermes");
    expect(result.project).toBe(root); // no project needed for hermes
    expect(hermes.started).toHaveLength(1);
    expect(claude.started).toHaveLength(0);
    await routed.execute("send_to_task", JSON.stringify({ task_id: result.task_id, message: "more" }), { userTranscript: "" });
    expect(sent).toEqual([result.task_id]);
    expect(await routed.execute("dispatch_task", JSON.stringify({ title: "x", goal: "y" }), { userTranscript: "" })).toEqual({
      error: "project is required for claude-code. Use list_projects.",
    });
  });

  it("returns errors to the model instead of throwing", async () => {
    expect(await tools.execute("get_task", '{"task_id":"t99"}', { userTranscript: "" })).toEqual({
      error: 'No task "t99". Use list_tasks.',
    });
  });
});

describe("ClaudeAcpWorker model policy", () => {
  it("refuses blocked models before touching any session", async () => {
    const { ClaudeAcpWorker } = await import("../src/workers/claude-acp.js");
    const registry = new TaskRegistry({ dir: tmpDir() });
    const worker = new ClaudeAcpWorker(registry, () => {}, { blockedModels: ["haiku"] });
    const task = registry.create({ title: "x", goal: "x", cwd: ".", worker: "claude-code", settings: {} });
    await expect(worker.configure(task, { model: "claude-haiku-4-5" })).rejects.toThrow(/blocked/);
    await expect(worker.configure(task, { model: "Haiku" })).rejects.toThrow(/blocked/);
  });
});

describe("TaskRegistry persistence", () => {
  it("reloads tasks and marks in-flight ones as interrupted", () => {
    const dir = tmpDir();
    const first = new TaskRegistry({ dir });
    const done = first.create({ title: "done", goal: "g", cwd: ".", worker: "claude-code", settings: {} });
    first.update(done, { status: "idle", sessionId: "s1", report: { headline: "ok", bullets: [], full: "ok" } });
    const busy = first.create({ title: "busy", goal: "g", cwd: ".", worker: "hermes", settings: {} });
    first.update(busy, {
      status: "needs_input",
      sessionId: "s2",
      currentText: "half a thought",
      pendingPermission: { question: "edit?", options: [] },
    });
    first.save();

    const second = new TaskRegistry({ dir });
    expect(second.get("t1")).toMatchObject({ status: "idle", sessionId: "s1", report: { headline: "ok" } });
    const reloaded = second.get("t2")!;
    expect(reloaded.status).toBe("failed");
    expect(reloaded.error).toMatch(/Interrupted by a restart.*follow-up/);
    expect(reloaded.pendingPermission).toBeUndefined();
    expect(reloaded.currentText).toBe("");
    expect(second.create({ title: "n", goal: "g", cwd: ".", worker: "claude-code", settings: {} }).id).toBe("t3");
  });
});

describe("Hermes model matching", () => {
  const models = {
    currentModelId: "openrouter:anthropic/claude-opus-5",
    availableModels: [
      { modelId: "openrouter:anthropic/claude-sonnet-5.5", name: "OpenRouter · anthropic/claude-sonnet-5.5" },
      { modelId: "openrouter:anthropic/claude-sonnet-5", name: "OpenRouter · anthropic/claude-sonnet-5" },
      { modelId: "anthropic:claude-sonnet-5", name: "Anthropic · claude-sonnet-5" },
      { modelId: "custom:qwen/qwen3.8-27b", name: "qwen/qwen3.8-27b" },
    ],
  };
  it("matches spoken names, preferring the current provider and the most specific id", () => {
    expect(matchModel(models, "sonnet 5")).toBe("openrouter:anthropic/claude-sonnet-5");
    expect(matchModel(models, "Qwen 3.8")).toBe("custom:qwen/qwen3.8-27b");
    expect(matchModel(models, "anthropic:claude-sonnet-5")).toBe("anthropic:claude-sonnet-5");
    expect(matchModel(models, "gpt")).toBeUndefined();
  });
});

describe("Discord status message", () => {
  it("shows status, plan and recent actions within Discord's limit", () => {
    const task = new TaskRegistry({ dir: tmpDir() }).create({ title: "t", goal: "g", cwd: ".", worker: "claude-code", settings: { model: "sonnet" } });
    task.status = "running";
    task.plan = ["[completed] read code", "[in_progress] fix bug"];
    task.tools = Array.from({ length: 40 }, (_, i) => ({ id: String(i), title: `Read file ${i} `.repeat(30), status: "completed" }));
    const text = renderStatus(task);
    expect(text).toContain("t1 running");
    expect(text).toContain("40 tool calls");
    expect(text).toContain("[in_progress] fix bug");
    expect(text.length).toBeLessThanOrEqual(1900);
  });
});
