import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryClient } from "../src/memory/client.js";
import { MemoryTools } from "../src/orchestrator/memory-tools.js";

interface Seen {
  path: string;
  auth?: string;
  service?: string;
  body: Record<string, unknown>;
}

/** A stand-in memory-core gateway speaking the v3 envelope. */
async function fakeGateway(handler: (path: string, body: Record<string, unknown>) => { code?: number; data?: unknown; status?: number; delayMs?: number }) {
  const seen: Seen[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    if (req.url === "/health") return void res.writeHead(200).end('{"status":"ok"}');
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    seen.push({ path: req.url!, auth: req.headers.authorization, service: req.headers["x-tdai-service-id"] as string, body });
    const out = handler(req.url!, body);
    if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
    res.writeHead(out.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: out.code ?? 0, message: "ok", data: out.data }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe("MemoryClient", () => {
  it("searches facts and conversation together, best first, without duplicates", async () => {
    const gw = await fakeGateway((path) =>
      path === "/v3/atomic/search"
        ? { data: { items: [{ content: "Matthew prefers dark mode", type: "persona", score: 0.8 }] } }
        : { data: { messages: [
            { content: "I like dark mode in every editor", role: "user", score: 0.9, timestamp: "2026-10-01T10:00:00Z" },
            { content: "Matthew prefers dark mode", role: "assistant", score: 0.2 },
          ] } },
    );
    open.push(gw);
    const memory = new MemoryClient({ url: gw.url, apiKey: "k", agentId: "shared" });
    const hits = await memory.search("dark mode", 5);
    expect(hits.map((h) => `${h.kind}:${h.text}`)).toEqual(["conversation:I like dark mode in every editor", "fact:Matthew prefers dark mode"]);
    // Auth, tenancy and the query all reach the gateway.
    expect(gw.seen[0]).toMatchObject({ auth: "Bearer k", service: "default", body: { query: "dark mode", agent_id: "shared", team_id: "default", user_id: "default" } });
  });

  it("still answers when only one of the two searches works", async () => {
    const gw = await fakeGateway((path) => (path === "/v3/atomic/search" ? { status: 500 } : { data: { messages: [{ content: "we chose Postgres", role: "user", score: 1 }] } }));
    open.push(gw);
    expect((await new MemoryClient({ url: gw.url }).search("database")).map((h) => h.text)).toEqual(["we chose Postgres"]);
  });

  it("saves conversation with ids, roles and timestamps", async () => {
    const gw = await fakeGateway(() => ({ data: { accepted_ids: ["m1", "m2"], total_count: 2 } }));
    open.push(gw);
    new MemoryClient({ url: gw.url, apiKey: "k" }).capture("voice-1-2026-10-06", [
      { role: "user", content: "remember my cat is Miso" },
      { role: "assistant", content: "Got it." },
      { role: "user", content: "   " }, // blank lines are dropped
    ]);
    await new Promise((r) => setTimeout(r, 100));
    expect(gw.seen).toHaveLength(1);
    expect(gw.seen[0]!.path).toBe("/v3/conversation/add");
    expect(gw.seen[0]!.body).toMatchObject({ session_id: "voice-1-2026-10-06", messages: [{ role: "user", content: "remember my cat is Miso" }, { role: "assistant", content: "Got it." }] });
  });

  it("gives up quickly on a slow server and stops calling a dead one for a while", async () => {
    const gw = await fakeGateway(() => ({ delayMs: 4000, data: {} }));
    open.push(gw);
    const logs: string[] = [];
    const memory = new MemoryClient({ url: gw.url, log: (...a) => logs.push(a.join(" ")) });
    const started = Date.now();
    await expect(memory.search("anything")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_800); // 3s search timeout, not 4s server time
    await expect(memory.search("again")).rejects.toThrow();
    await expect(memory.search("third")).rejects.toThrow();
    expect(memory.available).toBe(false);
    expect(logs.join("\n")).toContain("pausing calls");
    await expect(memory.search("fourth")).rejects.toThrow("unreachable"); // breaker open: no network call
  }, 20_000);

  it("reports health", async () => {
    const gw = await fakeGateway(() => ({}));
    open.push(gw);
    expect(await new MemoryClient({ url: gw.url }).healthy()).toBe(true);
    expect(await new MemoryClient({ url: "http://127.0.0.1:9" }).healthy()).toBe(false);
  });
});

describe("memory tools", () => {
  it("returns results for the model, and says when there are none", async () => {
    const gw = await fakeGateway((path) => (path === "/v3/atomic/search" ? { data: { items: [] } } : { data: { messages: [{ content: "x".repeat(900), role: "user", score: 1 }] } }));
    open.push(gw);
    const tools = new MemoryTools(new MemoryClient({ url: gw.url }));
    const found = (await tools.execute("memory_search", '{"query":"anything"}')) as { results: { from: string; text: string }[] };
    expect(found.results[0]!.from).toBe("earlier conversation (user)");
    expect(found.results[0]!.text.length).toBeLessThan(500); // long hits are clipped
    const gw2 = await fakeGateway(() => ({ data: { items: [], messages: [] } }));
    open.push(gw2);
    expect(await new MemoryTools(new MemoryClient({ url: gw2.url })).execute("memory_search", '{"query":"nothing"}')).toMatchObject({ results: [], note: expect.stringContaining("Nothing") });
  });

  it("saves what the user asks it to remember", async () => {
    const gw = await fakeGateway(() => ({ data: {} }));
    open.push(gw);
    const tools = new MemoryTools(new MemoryClient({ url: gw.url }));
    expect(await tools.execute("memory_remember", '{"text":"The user\'s cat is called Miso."}')).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(gw.seen[0]!.body).toMatchObject({ session_id: "notes", messages: [{ role: "user", content: "Remember this: The user's cat is called Miso." }] });
  });

  it("tells the model plainly when memory is unreachable", async () => {
    const tools = new MemoryTools(new MemoryClient({ url: "http://127.0.0.1:9" }));
    expect(await tools.execute("memory_search", '{"query":"hi"}')).toMatchObject({ error: expect.stringContaining("isn't reachable") });
  });
});
