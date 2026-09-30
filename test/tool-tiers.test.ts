import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ChatEvent, ChatMessage, ChatModel } from "../src/llm/chat.js";
import { McpTools } from "../src/lookup/mcp.js";
import { Workspace } from "../src/lookup/files.js";
import { BackgroundJobs } from "../src/orchestrator/background.js";
import { LookupTools } from "../src/orchestrator/lookup-tools.js";
import { QuickAgent } from "../src/orchestrator/quick-agent.js";
import { combineTools, type ToolSet } from "../src/orchestrator/toolset.js";
import { assistantTurn } from "../src/orchestrator/turn.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};

/** A tool set whose tools answer after the delay in their args, or throw. */
function slowTools(): ToolSet {
  return {
    definitions: [{ type: "function", function: { name: "slow", parameters: { type: "object", properties: {} } } }],
    handles: (name) => name === "slow" || name === "boom",
    async execute(name, raw, ctx) {
      if (name === "boom") throw new Error("kaboom");
      const { ms, value } = JSON.parse(raw) as { ms: number; value: string };
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        ctx.signal?.addEventListener("abort", () => (clearTimeout(t), reject(ctx.signal!.reason)));
      });
      return { value };
    },
  };
}

/** A chat model that plays back scripted rounds and records what it was sent. */
function scriptedChat(rounds: ChatEvent[][]) {
  const seen: ChatMessage[][] = [];
  const chat = {
    async *streamWithTools(messages: ChatMessage[]): AsyncIterable<ChatEvent> {
      seen.push(messages);
      yield* rounds[seen.length - 1] ?? [{ type: "text", text: "out of script" }];
    },
  } as unknown as ChatModel;
  return { chat, seen };
}

describe("BackgroundJobs", () => {
  it("answers inline when the tool is quick", async () => {
    const jobs = new BackgroundJobs({ waitMs: 200, timeoutMs: 1000, log: quiet });
    const notices: string[] = [];
    const result = await jobs.wrap(slowTools()).execute("slow", '{"ms":10,"value":"fast"}', { userTranscript: "", notify: (t) => notices.push(t) });
    expect(result).toEqual({ value: "fast" });
    expect(jobs.active).toBe(0);
    await sleep(50);
    expect(notices).toEqual([]);
  });

  it("moves a slow tool to the background and reports its result later", async () => {
    let finished = 0;
    const jobs = new BackgroundJobs({ waitMs: 30, timeoutMs: 1000, log: quiet, onFinish: () => finished++ });
    const notices: string[] = [];
    const result = await jobs.wrap(slowTools()).execute("slow", '{"ms":120,"value":"late"}', { userTranscript: "", notify: (t) => notices.push(t) });
    expect(result).toMatchObject({ status: "running_in_background", job_id: "j1" });
    expect(jobs.active).toBe(1);
    await sleep(200);
    expect(jobs.active).toBe(0);
    expect(finished).toBe(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^Background lookup j1 slow\(.*\) finished\. Result: \{"value":"late"\}$/);
  });

  it("backgrounds known-slow tools at once", async () => {
    const jobs = new BackgroundJobs({ waitMs: 1000, timeoutMs: 1000, log: quiet });
    const started = Date.now();
    const result = await jobs.wrap(slowTools(), 0).execute("slow", '{"ms":50,"value":"x"}', { userTranscript: "", notify: quiet });
    expect(result).toMatchObject({ status: "running_in_background" });
    expect(Date.now() - started).toBeLessThan(40);
  });

  it("gives up on background calls after the timeout", async () => {
    const jobs = new BackgroundJobs({ waitMs: 20, timeoutMs: 80, log: quiet });
    const notices: string[] = [];
    await jobs.wrap(slowTools()).execute("slow", '{"ms":5000,"value":"never"}', { userTranscript: "", notify: (t) => notices.push(t) });
    await sleep(150);
    expect(notices[0]).toMatch(/failed: timed out after 0.08s/);
  });

  it("just waits when there's nobody to notify, and turns throws into errors", async () => {
    const jobs = new BackgroundJobs({ waitMs: 10, timeoutMs: 1000, log: quiet });
    const tools = jobs.wrap(slowTools());
    expect(await tools.execute("slow", '{"ms":60,"value":"waited"}', { userTranscript: "" })).toEqual({ value: "waited" });
    expect(await tools.execute("boom", "{}", { userTranscript: "" })).toEqual({ error: "kaboom" });
  });
});

describe("assistantTurn tool calls", () => {
  it("runs a round's calls in parallel, keeps results in call order, and survives a throwing tool", async () => {
    const { chat, seen } = scriptedChat([
      [
        {
          type: "tool_calls",
          calls: [
            { id: "a", name: "slow", arguments: '{"ms":150,"value":"A"}' },
            { id: "b", name: "slow", arguments: '{"ms":150,"value":"B"}' },
            { id: "c", name: "boom", arguments: "{}" },
          ],
        },
      ],
      [{ type: "text", text: "Done." }],
    ]);
    const history: ChatMessage[] = [{ role: "user", content: "go" }];
    const started = Date.now();
    let final = "";
    const turn = assistantTurn({
      chat,
      history,
      tools: slowTools(),
      ctx: { userTranscript: "go" },
      signal: new AbortController().signal,
      log: quiet,
      onFinal: (t) => (final = t),
      system: "custom system",
    });
    for await (const _ of turn);
    expect(Date.now() - started).toBeLessThan(280); // two 150ms calls, not 300ms
    expect(final).toBe("Done.");
    expect(history.slice(2).map((m) => [m.role === "tool" && m.tool_call_id, m.content])).toEqual([
      ["a", '{"value":"A"}'],
      ["b", '{"value":"B"}'],
      ["c", '{"error":"kaboom"}'],
    ]);
    expect(seen[0]![0]).toEqual({ role: "system", content: "custom system" });
  });
});

/** An in-memory MCP server with a read-only tool, an acting tool and a failing one. */
function makeServer(): McpServer {
  const server = new McpServer({ name: "test", version: "1" });
  server.registerTool(
    "lookup",
    { description: "Look up a word.", inputSchema: { word: z.string() }, annotations: { readOnlyHint: true } },
    async ({ word }) => ({ content: [{ type: "text", text: `${word} means something` }] }),
  );
  server.registerTool("send", { description: "Send a message.", inputSchema: { to: z.string() } }, async () => ({
    content: [{ type: "text", text: "sent" }],
  }));
  server.registerTool("broken", { description: "Always fails." }, async () => ({ content: [{ type: "text", text: "no such thing" }], isError: true }));
  server.registerTool("hidden", { description: "Not allowlisted." }, async () => ({ content: [] }));
  return server;
}

function mcpTools(tools: "*" | string[] = ["lookup", "send", "broken"]) {
  const servers: McpServer[] = [];
  const mcp = new McpTools(
    { dict: { args: [], env: {}, headers: {}, tools, enabled: true, url: "memory://" } },
    quiet,
    4000,
    () => {
      const [client, server] = InMemoryTransport.createLinkedPair();
      const mcpServer = makeServer();
      servers.push(mcpServer);
      void mcpServer.connect(server);
      return client;
    },
  );
  return { mcp, servers };
}

describe("McpTools", () => {
  it("offers only allowlisted tools, prefixed, flagging ones that aren't read-only", async () => {
    const { mcp } = mcpTools();
    expect(mcp.definitions).toEqual([]); // nothing until connected
    await mcp.connect();
    const defs = Object.fromEntries(mcp.definitions.map((d) => (d.type === "function" ? [d.function.name, d.function] : [])));
    expect(Object.keys(defs).sort()).toEqual(["dict__broken", "dict__lookup", "dict__send"]);
    expect(defs.dict__lookup.description).toBe("Look up a word.");
    expect(defs.dict__send.description).toBe("(Takes action: confirm with the user first.) Send a message.");
    expect(defs.dict__lookup.parameters).toMatchObject({ type: "object", properties: { word: { type: "string" } } });
    expect(defs.dict__lookup.parameters).not.toHaveProperty("$schema");
    expect(mcp.handles("dict__hidden")).toBe(false);
    await mcp.close();
  });

  it("calls tools and reports tool errors", async () => {
    const { mcp } = mcpTools("*");
    await mcp.connect();
    expect(mcp.handles("dict__hidden")).toBe(true);
    expect(await mcp.execute("dict__lookup", '{"word":"mcp"}', { userTranscript: "" })).toEqual({ result: "mcp means something" });
    expect(await mcp.execute("dict__broken", "{}", { userTranscript: "" })).toEqual({ error: "no such thing" });
    expect(await mcp.execute("dict__lookup", "{}", { userTranscript: "" })).toHaveProperty("error"); // bad input
    await mcp.close();
  });

  it("reconnects once when the server has gone away", async () => {
    const { mcp, servers } = mcpTools();
    await mcp.connect();
    await servers[0]!.close();
    expect(await mcp.execute("dict__lookup", '{"word":"again"}', { userTranscript: "" })).toEqual({ result: "again means something" });
    expect(servers).toHaveLength(2);
    await mcp.close();
  });

  it("reads servers from YAML and treats a missing file as none", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-"));
    expect(McpTools.fromFile(join(dir, "missing.yaml"), quiet).definitions).toEqual([]);
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, "servers:\n  x:\n    command: foo\n    url: http://bar\n    tools: '*'\n");
    expect(() => McpTools.fromFile(bad, quiet)).toThrow(/either command or url/);
  });
});

describe("QuickAgent", () => {
  it("answers with its own prompt and read-only lookups", async () => {
    const root = mkdtempSync(join(tmpdir(), "quick-"));
    writeFileSync(join(root, "notes.txt"), "The NAS is called Potato Server.");
    const { chat, seen } = scriptedChat([
      [{ type: "tool_calls", calls: [{ id: "1", name: "read_file", arguments: JSON.stringify({ path: join(root, "notes.txt") }) }] }],
      [{ type: "text", text: "Your NAS is called Potato Server." }],
    ]);
    const agent = new QuickAgent({ chat, tools: new LookupTools(new Workspace([root])), roots: [root], log: quiet });
    const result = await agent.execute("quick_agent", '{"question":"What is my NAS called?"}', { userTranscript: "what's my nas called" });
    expect(result).toEqual({ answer: "Your NAS is called Potato Server.", lookups: 1 });
    expect(seen[0]![0]!.content).toMatch(/^You are a research helper/);
    expect(seen[0]![1]).toEqual({ role: "user", content: "What is my NAS called?" });
    expect(JSON.stringify(seen[1]!.at(-1))).toContain("Potato Server");
  });

  it("goes to the background like any slow lookup when wrapped", async () => {
    const { chat } = scriptedChat([]);
    const slowChat = {
      async *streamWithTools(...a: Parameters<ChatModel["streamWithTools"]>) {
        await sleep(80);
        yield* chat.streamWithTools(...a);
      },
    } as unknown as ChatModel;
    const jobs = new BackgroundJobs({ waitMs: 20, timeoutMs: 1000, log: quiet });
    const tools = combineTools(jobs.wrap(new QuickAgent({ chat: slowChat, tools: combineTools(), roots: [], log: quiet })));
    const notices: string[] = [];
    const first = await tools.execute("quick_agent", '{"question":"q"}', { userTranscript: "", notify: (t) => notices.push(t) });
    expect(first).toMatchObject({ status: "running_in_background" });
    await sleep(150);
    expect(notices[0]).toMatch(/^Background lookup j1 quick_agent\(.*\) finished\. Result: \{"answer":"out of script","lookups":0\}$/);
  });
});
