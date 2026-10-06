import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatMessage, ChatModel } from "../src/llm/chat.js";
import { assistantTurn } from "../src/orchestrator/turn.js";

function scriptedChat(rounds: ChatEvent[][]) {
  let n = 0;
  return { async *streamWithTools(): AsyncIterable<ChatEvent> { yield* rounds[n++] ?? [{ type: "text", text: "out of script" }]; } } as unknown as ChatModel;
}

async function run(rounds: ChatEvent[][]) {
  const history: ChatMessage[] = [{ role: "user", content: "go for it" }];
  const executed: string[] = [];
  let final = "";
  const turn = assistantTurn({
    chat: scriptedChat(rounds),
    history,
    tools: { definitions: [], execute: (name, args) => (executed.push(`${name}${args}`), { ok: true }) },
    ctx: { userTranscript: "go for it" },
    signal: new AbortController().signal,
    log: () => {},
    onFinal: (t) => (final = t),
    system: "test",
  });
  for await (const _ of turn) void _;
  return { history, executed, final };
}

describe("tool calls cut off at the token limit", () => {
  const cut = { id: "c1", name: "dispatch_task", arguments: '{"title":"x","goal":"a very long brief that never ends' };

  it("doesn't run the broken call, tells the model, and lets it retry", async () => {
    const { history, executed, final } = await run([
      [{ type: "tool_calls", calls: [cut], truncated: true }],
      [{ type: "tool_calls", calls: [{ id: "c2", name: "dispatch_task", arguments: '{"title":"x","goal":"short"}' }] }],
      [{ type: "text", text: "Sent." }],
    ]);
    expect(executed).toEqual(['dispatch_task{"title":"x","goal":"short"}']);
    expect(final).toBe("Sent.");
    const toolMsgs = history.filter((m) => m.role === "tool");
    expect(String(toolMsgs[0]!.content)).toMatch(/output length limit.*nothing ran/);
    // The broken arguments aren't kept in the history, where they'd cost context on every later turn.
    expect(JSON.stringify(history)).not.toContain("never ends");
  });
});
