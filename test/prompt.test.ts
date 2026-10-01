import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeSystemPrompt,
  activeSystemPromptName,
  CHATTY_SYSTEM_PROMPT,
  GRILL_SYSTEM_PROMPT,
  setActiveSystemPrompt,
  VOICE_SYSTEM_PROMPT,
} from "../src/orchestrator/prompt.js";
import { TaskTools } from "../src/orchestrator/tools.js";
import { assistantTurn } from "../src/orchestrator/turn.js";
import { TaskRegistry } from "../src/tasks/registry.js";
import type { ChatEvent, ChatMessage, ChatModel } from "../src/llm/chat.js";
import type { WorkerAdapter } from "../src/workers/types.js";

const tools = () =>
  new TaskTools(new TaskRegistry({ dir: mkdtempSync(join(tmpdir(), "prompt-")) }), { name: "claude-code" } as WorkerAdapter, [tmpdir()]);
const ctx = { userTranscript: "" };

describe("system prompts", () => {
  afterEach(() => setActiveSystemPrompt("default"));

  it("starts on the default prompt", () => {
    expect(activeSystemPromptName()).toBe("default");
    expect(activeSystemPrompt()).toBe(VOICE_SYSTEM_PROMPT);
  });

  it("both prompts keep the agent rules", () => {
    for (const prompt of [VOICE_SYSTEM_PROMPT, CHATTY_SYSTEM_PROMPT]) {
      expect(prompt).toContain("Before dispatch_task");
      expect(prompt).toContain("call grill_me");
    }
  });

  it("switch_system_prompt changes the active prompt and rejects unknown names", async () => {
    const t = tools();
    expect(t.definitions.map((d) => d.type === "function" && d.function.name)).toContain("switch_system_prompt");
    expect(await t.execute("switch_system_prompt", '{"name":"Chatty"}', ctx)).toEqual({ ok: true, previous: "default", active: "chatty" });
    expect(activeSystemPrompt()).toBe(CHATTY_SYSTEM_PROMPT);
    expect(await t.execute("switch_system_prompt", '{"name":"grumpy"}', ctx)).toHaveProperty("error");
    expect(activeSystemPromptName()).toBe("chatty");
  });

  it("grill_me switches to the grill prompt and remembers which prompt to go back to", async () => {
    const t = tools();
    setActiveSystemPrompt("chatty");
    expect(await t.execute("grill_me", '{"topic":"my startup plan"}', ctx)).toMatchObject({ ok: true, topic: "my startup plan", return_to: "chatty" });
    expect(activeSystemPrompt()).toBe(GRILL_SYSTEM_PROMPT);
    expect(await t.execute("grill_me", "{}", ctx)).toMatchObject({ return_to: "default" });
    expect(GRILL_SYSTEM_PROMPT).toMatch(/ONE question per reply/);
    expect(GRILL_SYSTEM_PROMPT).toContain("Before dispatch_task");
  });

  it("a switch mid-turn applies to the model's next round", async () => {
    const seen: string[] = [];
    const chat = {
      async *streamWithTools(messages: ChatMessage[]): AsyncIterable<ChatEvent> {
        seen.push(messages[0].content as string);
        if (seen.length === 1) {
          yield { type: "tool_calls", calls: [{ id: "1", name: "switch_system_prompt", arguments: '{"name":"chatty"}' }] };
        } else {
          yield { type: "text", text: "Hey there!" };
        }
      },
    } as unknown as ChatModel;
    const t = tools();
    const turn = assistantTurn({
      chat,
      history: [{ role: "user", content: "be chattier" }],
      tools: { definitions: t.definitions, execute: t.execute.bind(t) },
      ctx,
      signal: new AbortController().signal,
      log: () => {},
      onFinal: () => {},
    });
    for await (const _ of turn);
    expect(seen).toEqual([VOICE_SYSTEM_PROMPT, CHATTY_SYSTEM_PROMPT]);
  });
});
