import { describe, expect, it } from "vitest";
import { runScript, type ScriptToolCaller } from "../src/sandbox/script.js";

const echo: ScriptToolCaller = async (name, args) => {
  if (name === "boom") return { error: "kaboom" };
  if (name === "slow") {
    await new Promise((r) => setTimeout(r, Number(args.ms)));
    return { slept: args.ms };
  }
  return { name, args };
};

describe("runScript", () => {
  it("returns the script's value and calls tools", async () => {
    const r = await runScript(`const a = await tools.hello({x: 1}); return a.args.x + 1;`, echo);
    expect(r).toEqual({ output: "2", toolCalls: 1 });
  });

  it("runs tool calls in parallel and keeps console output", async () => {
    const start = Date.now();
    const r = await runScript(
      `console.log("hi", {a: 1}); const rs = await Promise.all([1,2,3].map((i) => tools.slow({ms: 150}))); return rs.length;`,
      echo,
    );
    expect(r.output).toBe("3");
    expect(r.logs).toBe('hi {"a":1}');
    expect(Date.now() - start).toBeLessThan(420);
  });

  it("turns a tool error into a catchable exception", async () => {
    const r = await runScript(`try { await tools.boom({}); } catch (e) { return e.message; }`, echo);
    expect(r.output).toBe("boom: kaboom");
  });

  it("reports script errors and syntax errors", async () => {
    expect((await runScript(`throw new Error("nope")`, echo)).error).toContain("nope");
    expect((await runScript(`return (`, echo)).error).toBeTruthy();
  });

  it("has no access to the host", async () => {
    const r = await runScript(
      `return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof globalThis.Deno].join(",")`,
      echo,
    );
    expect(r.output).toBe("undefined,undefined,undefined,undefined,undefined");
  });

  it("stops an endless loop", async () => {
    const r = await runScript(`while (true) {}`, echo, { timeoutMs: 300 });
    expect(r.error).toMatch(/too long|timed out/);
  });

  it("stops memory hogs", async () => {
    const r = await runScript(`const a = []; for (let i = 0; ; i++) a.push({ i });`, echo, { memoryBytes: 4 * 1024 * 1024 });
    expect(r.error).toBeTruthy();
  });

  it("caps tool calls", async () => {
    const r = await runScript(`for (let i = 0; i < 10; i++) await tools.hello({}); return "done";`, echo, { maxToolCalls: 3 });
    expect(r.error).toContain("more than 3 tool calls");
  });

  it("times out while waiting on a slow tool", async () => {
    const r = await runScript(`await tools.slow({ms: 5000}); return 1;`, echo, { timeoutMs: 200 });
    expect(r.error).toContain("timed out");
  });

  it("truncates long output", async () => {
    const r = await runScript(`return "a".repeat(5000)`, echo, { maxOutputChars: 100 });
    expect(r.output!.length).toBeLessThan(160);
  });
});

describe("CodeModeTools", () => {
  it("lists only read-only tools and runs a script over them", async () => {
    const { CodeModeTools } = await import("../src/orchestrator/code-mode.js");
    const inner = {
      definitions: [
        { type: "function" as const, function: { name: "look", description: "Look something up. More text.", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } } },
        { type: "function" as const, function: { name: "send", description: "(Takes action: confirm with the user first.) Sends it.", parameters: { type: "object", properties: {} } } },
      ],
      handles: () => true,
      execute: async (name: string, raw: string) => ({ name, got: JSON.parse(raw).q }),
    };
    const mode = new CodeModeTools(inner, () => {});
    const api = mode.describeApi();
    expect(api).toContain("tools.look({q}): Look something up.");
    expect(api).not.toContain("send");
    const ok = await mode.execute("run_script", JSON.stringify({ code: `const r = await Promise.all(["a","b"].map((q) => tools.look({q}))); return r.map((x) => x.got);` }), { userTranscript: "" });
    expect(ok).toEqual({ output: '["a","b"]', tool_calls: 2 });
    const bad = (await mode.execute("run_script", JSON.stringify({ code: `return await tools.send({});` }), { userTranscript: "" })) as { error: string };
    expect(bad.error).toContain("no tool named send");
  });
});

describe("find_tools", () => {
  it("hides deferred servers until found, and quick tiers see everything", async () => {
    const { McpTools } = await import("../src/lookup/mcp.js");
    const { FindTools } = await import("../src/orchestrator/find-tools.js");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { z } = await import("zod");
    const server = new McpServer({ name: "cal", version: "1" });
    server.registerTool("get_events", { description: "List calendar events", inputSchema: { day: z.string() }, annotations: { readOnlyHint: true } }, async ({ day }) => ({ content: [{ type: "text", text: `events on ${day}` }] }));
    server.registerTool("search_mail", { description: "Search the user's email", inputSchema: { q: z.string() }, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "mail" }] }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const mcp = new McpTools({ cal: { args: [], env: {}, headers: {}, tools: "*", core: false, enabled: true, command: "x" } }, () => {}, 4000, () => a);
    await mcp.connect();
    const find = new FindTools(mcp);
    expect(mcp.definitions).toEqual([]);
    expect(mcp.catalog).toHaveLength(2);
    expect(mcp.full().definitions).toHaveLength(2);
    expect(JSON.stringify(find.definitions)).toContain("cal (2)");
    const hit = find.execute("find_tools", '{"query":"calendar events"}') as { found: { name: string }[] };
    expect(hit.found[0]!.name).toBe("cal__get_events");
    expect(mcp.definitions.map((d) => (d.type === "function" ? d.function.name : ""))).toEqual(["cal__get_events"]);
    expect(await mcp.execute("cal__get_events", '{"day":"mon"}', { userTranscript: "" })).toEqual({ result: "events on mon" });
    expect((find.execute("find_tools", '{"query":"zzz"}') as { found: unknown[] }).found).toEqual([]);
  });
});
