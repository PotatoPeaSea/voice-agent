import { describe, expect, it } from "vitest";
import { DiscordTools, findChannel, type DiscordChannel, type DiscordGateway, type DiscordMessage } from "../src/orchestrator/discord-tools.js";

const CHANNELS: DiscordChannel[] = [
  { id: "1", name: "general", category: "Text" },
  { id: "2", name: "fantasy-basketball", category: "Sports" },
  { id: "3", name: "fantasy-football", category: "Sports" },
  { id: "4", name: "task-reports" },
];

function msg(over: Partial<DiscordMessage> = {}): DiscordMessage {
  return { id: "m", author: "Matthew", isBot: false, content: "hi", at: new Date(Date.now() - 5 * 60_000), attachments: 0, embeds: 0, ...over };
}

function setup(messages: DiscordMessage[] = []) {
  const sent: { channelId: string; text: string }[] = [];
  const fetched: { channelId: string; limit: number }[] = [];
  const gateway: DiscordGateway = {
    channels: async () => CHANNELS,
    messages: async (channelId, limit) => (fetched.push({ channelId, limit }), messages),
    send: async (channelId, text) => void sent.push({ channelId, text }),
  };
  const tools = new DiscordTools(gateway);
  const call = (name: string, args: object, turn = 1, transcript = "x") =>
    tools.execute(name, JSON.stringify(args), { userTranscript: transcript, userTurn: turn }) as Promise<Record<string, any>>;
  return { call, sent, fetched };
}

describe("findChannel", () => {
  it("matches by id, spoken name, or a unique partial", () => {
    expect(findChannel(CHANNELS, "2")).toMatchObject({ id: "2" });
    expect(findChannel(CHANNELS, "Task Reports")).toMatchObject({ id: "4" });
    expect(findChannel(CHANNELS, "#general")).toMatchObject({ id: "1" });
    expect(findChannel(CHANNELS, "basketball")).toMatchObject({ id: "2" });
  });

  it("asks when ambiguous and lists channels when nothing matches", () => {
    expect(findChannel(CHANNELS, "fantasy")).toMatchObject({ error: expect.stringContaining("several channels") });
    expect(findChannel(CHANNELS, "cooking")).toMatchObject({ error: expect.stringContaining("Available: general") });
  });
});

describe("discord tools", () => {
  it("lists channels with categories", async () => {
    const { call } = setup();
    expect((await call("discord_channels", {})).channels).toEqual(["general (Text)", "fantasy-basketball (Sports)", "fantasy-football (Sports)", "task-reports"]);
  });

  it("reads recent messages for speech", async () => {
    const { call, fetched } = setup([msg({ content: "trade accepted" }), msg({ author: "Hermes", isBot: true, content: "x".repeat(900) }), msg({ content: "", attachments: 2 })]);
    const result = await call("discord_read", { channel: "general", limit: 50 });
    expect(fetched).toEqual([{ channelId: "1", limit: 30 }]); // limit capped
    expect(result.messages[0]).toMatchObject({ from: "Matthew", when: "5 min ago", text: "trade accepted" });
    expect(result.messages[1].from).toBe("Hermes (bot)");
    expect(result.messages[1].text.length).toBeLessThan(600);
    expect(result.messages[2].text).toBe("[2 attachment(s)]");
  });

  it("filters by text within the latest 100", async () => {
    const { call, fetched } = setup([msg({ content: "lunch?" }), msg({ content: "Trade offer from Dan" })]);
    const result = await call("discord_read", { channel: "general", contains: "trade" });
    expect(fetched[0]!.limit).toBe(100);
    expect(result.messages.map((m: any) => m.text)).toEqual(["Trade offer from Dan"]);
  });

  it("explains blank messages (intent off) instead of reporting an empty channel", async () => {
    const { call } = setup([msg({ content: "" }), msg({ content: "" })]);
    expect((await call("discord_read", { channel: "general" })).note).toContain("Message Content intent");
    const none = setup([]);
    expect((await none.call("discord_read", { channel: "general" })).note).toBe("No messages found.");
  });

  it("posts only after the user says yes in a later turn", async () => {
    const { call, sent } = setup();
    const proposed = await call("discord_send", { channel: "general", text: "Standup in five." }, 1, "tell general standup is in five");
    expect(proposed).toMatchObject({ needs_confirmation: true, confirm_id: "d1", channel: "general" });
    expect(sent).toEqual([]);
    expect(await call("discord_send", { confirm_id: "d1" }, 1, "tell general standup is in five")).toHaveProperty("error"); // same turn
    expect(sent).toEqual([]);
    expect(await call("discord_send", { confirm_id: "d1" }, 2, "yes send it")).toEqual({ ok: true, posted_to: "general" });
    expect(sent).toEqual([{ channelId: "1", text: "Standup in five." }]);
    expect(await call("discord_send", { confirm_id: "d1" }, 3, "yes")).toHaveProperty("error"); // single use
  });

  it("drops a post the user declines, and refuses overlong or unknown-channel posts", async () => {
    const { call, sent } = setup();
    await call("discord_send", { channel: "general", text: "hello" }, 1);
    expect(await call("discord_send", { confirm_id: "d1" }, 2, "no, cancel that")).toHaveProperty("error");
    expect(sent).toEqual([]);
    expect(await call("discord_send", { channel: "general", text: "x".repeat(2000) })).toHaveProperty("error");
    expect(await call("discord_send", { channel: "cooking", text: "hi" })).toMatchObject({ error: expect.stringContaining("No channel") });
  });
});
