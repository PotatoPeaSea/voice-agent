import type { Guild } from "discord.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { Confirmations } from "./confirm.js";
import type { ToolContext } from "./tools.js";
import { errorMessage, parseArgs, toolName, truncate, type ToolSet } from "./toolset.js";

const MAX_MESSAGE_CHARS = 500;
const MAX_SEND_CHARS = 1_900;

export interface DiscordChannel {
  id: string;
  name: string;
  /** Category (folder) it sits in, if any. */
  category?: string;
}

export interface DiscordMessage {
  id: string;
  author: string;
  isBot: boolean;
  content: string;
  at: Date;
  attachments: number;
  embeds: number;
}

/** What the tools need from Discord (a seam for tests; DiscordJsGateway is the real thing). */
export interface DiscordGateway {
  channels(): Promise<DiscordChannel[]>;
  messages(channelId: string, limit: number): Promise<DiscordMessage[]>;
  send(channelId: string, text: string): Promise<void>;
}

/** The voice bot's own Discord connection, limited to its home server. */
export class DiscordJsGateway implements DiscordGateway {
  constructor(private readonly guild: () => Guild | undefined) {}

  private get home(): Guild {
    const guild = this.guild();
    if (!guild) throw new Error("not connected to Discord yet");
    return guild;
  }

  async channels(): Promise<DiscordChannel[]> {
    const all = await this.home.channels.fetch();
    return [...all.values()]
      .filter((c): c is NonNullable<typeof c> => !!c && c.isTextBased() && !c.isThread())
      .map((c) => ({ id: c.id, name: c.name, category: c.parent?.name }))
      .sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name));
  }

  async messages(channelId: string, limit: number): Promise<DiscordMessage[]> {
    const channel = await this.home.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error("that isn't a text channel");
    const found = await channel.messages.fetch({ limit });
    return [...found.values()]
      .map((m) => ({
        id: m.id,
        author: m.member?.displayName ?? m.author.globalName ?? m.author.username,
        isBot: m.author.bot,
        content: m.content,
        at: m.createdAt,
        attachments: m.attachments.size,
        embeds: m.embeds.length,
      }))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  async send(channelId: string, text: string): Promise<void> {
    const channel = await this.home.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error("can't send to that channel");
    // No pings, whatever the text says.
    await channel.send({ content: text, allowedMentions: { parse: [] } });
  }
}

export const DISCORD_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "discord_channels",
      description: "List the text channels in the user's Discord server (the one you're in), with their categories.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_read",
      description:
        "Read the latest messages in a channel of the user's Discord server, oldest first. Use when the user asks what was said in a channel, " +
        "whether someone posted, or to catch up. Summarize for speech; don't read messages out one by one unless asked.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name as the user said it (e.g. general, fantasy-basketball) or its id." },
          limit: { type: "number", description: "How many recent messages, 1-30 (default 15)." },
          contains: { type: "string", description: "Only messages containing this text (searched in the latest 100)." },
        },
        required: ["channel"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_send",
      description:
        "Post a message to a channel of the user's Discord server as yourself (the bot). Takes action: it only happens after the user agrees. " +
        "The first call comes back as needs_confirmation: read the message and channel back in one sentence, wait for their yes in their next reply, " +
        "then call again with just confirm_id. Mentions never ping anyone.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name or id." },
          text: { type: "string", description: "The message, plain text." },
          confirm_id: { type: "string", description: "The id from needs_confirmation, after the user said yes. Pass nothing else." },
        },
      },
    },
  },
];

const NAMES = new Set(DISCORD_TOOL_DEFINITIONS.map(toolName));
const loose = (s: string) => s.toLowerCase().replace(/^#/, "").replace(/[\s_-]+/g, "");

/** Best channel for what the user said: exact id, then name ignoring case/spaces/dashes, then a unique partial match. */
export function findChannel(channels: DiscordChannel[], wanted: string): DiscordChannel | { error: string } {
  const text = wanted.trim();
  const byId = channels.find((c) => c.id === text);
  if (byId) return byId;
  const key = loose(text);
  if (!key) return { error: "no channel given" };
  const exact = channels.filter((c) => loose(c.name) === key);
  if (exact.length === 1) return exact[0]!;
  const partial = channels.filter((c) => loose(c.name).includes(key) || key.includes(loose(c.name)));
  const pool = exact.length ? exact : partial;
  if (pool.length === 1) return pool[0]!;
  if (!pool.length) return { error: `No channel matches "${wanted}". Available: ${channels.map((c) => c.name).join(", ")}` };
  return { error: `"${wanted}" matches several channels (${pool.map((c) => c.name).join(", ")}). Ask which one.` };
}

function ago(at: Date, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at.getTime()) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

/** The voice model's access to the user's Discord server through the bot's own connection. */
export class DiscordTools implements ToolSet {
  readonly definitions = DISCORD_TOOL_DEFINITIONS;
  private readonly confirmations = new Confirmations<{ channel: DiscordChannel; text: string }>("d");

  constructor(
    private readonly gateway: DiscordGateway,
    private readonly log: (...a: unknown[]) => void = () => {},
  ) {}

  handles(name: string): boolean {
    return NAMES.has(name);
  }

  async execute(name: string, rawArgs: string, ctx: ToolContext): Promise<unknown> {
    const args = parseArgs(rawArgs);
    if (typeof args === "string") return { error: args };
    const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
    try {
      switch (name) {
        case "discord_channels": {
          const channels = await this.gateway.channels();
          return { channels: channels.map((c) => (c.category ? `${c.name} (${c.category})` : c.name)) };
        }
        case "discord_read": {
          const channel = findChannel(await this.gateway.channels(), str("channel"));
          if ("error" in channel) return channel;
          const limit = Math.min(30, Math.max(1, Math.round(Number(args.limit)) || 15));
          const contains = str("contains").toLowerCase();
          let messages = await this.gateway.messages(channel.id, contains ? 100 : limit);
          if (contains) messages = messages.filter((m) => m.content.toLowerCase().includes(contains)).slice(-limit);
          const hidden = messages.length > 0 && messages.every((m) => !m.content && !m.attachments && !m.embeds && !m.isBot);
          return {
            channel: channel.name,
            count: messages.length,
            messages: messages.map((m) => ({
              from: m.isBot ? `${m.author} (bot)` : m.author,
              when: ago(m.at),
              text: truncate(m.content, MAX_MESSAGE_CHARS) || (m.attachments ? `[${m.attachments} attachment(s)]` : m.embeds ? "[embed]" : ""),
            })),
            ...(hidden
              ? { note: "Message text is blank: the bot's Message Content intent is off in the Discord developer portal, so it can't see what people wrote." }
              : messages.length === 0
                ? { note: "No messages found." }
                : {}),
          };
        }
        case "discord_send": {
          const confirmId = str("confirm_id");
          if (confirmId) {
            const taken = this.confirmations.take(confirmId, ctx);
            if (!taken.ok) return { error: taken.error };
            await this.gateway.send(taken.payload.channel.id, taken.payload.text);
            this.log(`discord: posted to #${taken.payload.channel.name}`);
            return { ok: true, posted_to: taken.payload.channel.name };
          }
          const text = str("text");
          if (!text) return { error: "say what to post, or give a confirm_id" };
          if (text.length > MAX_SEND_CHARS) return { error: `That's too long for one message (${text.length} characters; the limit is ${MAX_SEND_CHARS}). Shorten it.` };
          const channel = findChannel(await this.gateway.channels(), str("channel"));
          if ("error" in channel) return channel;
          const id = this.confirmations.propose({ channel, text }, ctx);
          return {
            needs_confirmation: true,
            confirm_id: id,
            channel: channel.name,
            text,
            note: "Not posted yet. Read the message and channel back in one sentence, ask if you should post it, and only after the user says yes in their next reply call discord_send with just this confirm_id.",
          };
        }
        default:
          return { error: `unknown tool ${name}` };
      }
    } catch (err) {
      const message = errorMessage(err);
      return { error: /Missing (Access|Permissions)/i.test(message) ? "The bot doesn't have permission to do that in that channel (it needs View Channel, Read Message History, and Send Messages to post)." : message };
    }
  }
}
