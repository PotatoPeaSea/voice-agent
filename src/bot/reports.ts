import { AttachmentBuilder, ChannelType, type Client, type Message, type SendableChannels } from "discord.js";
import type { TaskRegistry } from "../tasks/registry.js";
import type { Task, TaskEvent } from "../tasks/types.js";

const STATUS_EDIT_MS = 3_000;
const MAX_MESSAGE = 1_900; // Discord's limit is 2000
const STATUS_ICON: Record<Task["status"], string> = {
  starting: "🟡",
  running: "⏳",
  needs_input: "✋",
  idle: "✅",
  failed: "❌",
  cancelled: "⏹️",
};

interface Target {
  channel: SendableChannels;
  status?: Message;
  lastStatus?: string;
}

/**
 * Mirrors tasks into Discord text so diffs and logs are readable while the voice
 * channel only gets headlines. Each task gets a thread in the reports channel (or,
 * without one, messages in the voice channel's own chat) holding the brief, a
 * status message that is edited as the agent works, and each turn's full report.
 */
export class TaskReporter {
  private readonly targets = new Map<string, Promise<Target | undefined>>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private home?: SendableChannels;

  constructor(
    private readonly client: Client,
    private readonly registry: TaskRegistry,
    private readonly channelId: string,
    private readonly log: (...a: unknown[]) => void,
  ) {}

  async start(): Promise<void> {
    const channel = await this.client.channels.fetch(this.channelId);
    if (!channel?.isSendable()) throw new Error(`reports channel ${this.channelId} isn't a channel the bot can post in`);
    this.home = channel;
    this.registry.on("created", (task) => this.run(task, () => this.target(task)));
    this.registry.on("update", (task) => this.scheduleStatus(task));
    this.registry.on("event", (event) => this.run(event.task, () => this.onEvent(event)));
    this.log(`task reports -> #${"name" in channel ? channel.name : channel.id}${this.usesThreads() ? " (a thread per task)" : ""}`);
  }

  private usesThreads(): boolean {
    const type = (this.home as { type?: ChannelType }).type;
    return type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement;
  }

  /** Run Discord calls for one task in order (the thread must exist before anything is posted to it). */
  private run(task: Task, op: () => Promise<unknown>): void {
    const next = (this.chains.get(task.id) ?? Promise.resolve())
      .then(op)
      .catch((err: Error) => this.log(`discord report for ${task.id} failed: ${err.message}`));
    this.chains.set(task.id, next);
  }

  /** Where a task's messages go: cached, found again after a restart, or created now. */
  private target(task: Task): Promise<Target | undefined> {
    let target = this.targets.get(task.id);
    if (!target) {
      target = (task.discord ? this.reopen(task) : this.open(task)).catch((err: Error) => {
        this.targets.delete(task.id);
        throw err;
      });
      this.targets.set(task.id, target);
    }
    return target;
  }

  private async open(task: Task): Promise<Target> {
    const home = this.home!;
    let channel: SendableChannels = home;
    if (this.usesThreads()) {
      const threads = (home as unknown as { threads: { create(o: object): Promise<SendableChannels & { id: string }> } }).threads;
      channel = await threads.create({ name: `${task.id} · ${task.title}`.slice(0, 100), autoArchiveDuration: 1440 });
    }
    await channel.send({ content: clip(brief(task, !this.usesThreads())), allowedMentions: { parse: [] } });
    const status = await channel.send({ content: renderStatus(task), allowedMentions: { parse: [] } });
    this.registry.update(task, { discord: { channelId: channel.id, statusMessageId: status.id } });
    return { channel, status, lastStatus: status.content };
  }

  private async reopen(task: Task): Promise<Target> {
    const { channelId, statusMessageId } = task.discord!;
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error(`can't post to ${channelId} any more`);
    const status = statusMessageId && "messages" in channel ? await channel.messages.fetch(statusMessageId).catch(() => undefined) : undefined;
    return { channel, status };
  }

  /** Status edits are throttled: agents update tasks on every streamed token. */
  private scheduleStatus(task: Task): void {
    if (this.timers.has(task.id)) return;
    this.timers.set(
      task.id,
      setTimeout(() => {
        this.timers.delete(task.id);
        this.run(task, () => this.refreshStatus(task));
      }, STATUS_EDIT_MS),
    );
  }

  private async refreshStatus(task: Task): Promise<void> {
    if (!this.targets.has(task.id) && !task.discord) return; // not created in Discord yet (e.g. from before this feature)
    const target = await this.target(task);
    if (!target) return;
    const content = renderStatus(task);
    if (content === target.lastStatus) return;
    target.lastStatus = content;
    if (target.status) {
      await target.status.edit({ content, allowedMentions: { parse: [] } });
    } else {
      target.status = await target.channel.send({ content, allowedMentions: { parse: [] } });
      this.registry.update(task, { discord: { channelId: target.channel.id, statusMessageId: target.status.id } });
    }
  }

  private async onEvent(event: TaskEvent): Promise<void> {
    const { task } = event;
    const target = await this.target(task);
    if (!target) return;
    await this.refreshStatus(task);
    const prefix = this.usesThreads() ? "" : `**${task.id}** `;
    switch (event.type) {
      case "finished": {
        const report = task.report;
        if (!report) return;
        const summary = `${prefix}**Turn ${task.turns} finished:** ${report.headline}`;
        if (summary.length + report.full.length + 2 <= MAX_MESSAGE) {
          await target.channel.send({ content: `${summary}\n\n${report.full}`, allowedMentions: { parse: [] } });
        } else {
          const bullets = report.bullets.map((b) => `- ${b}`).join("\n");
          await target.channel.send({
            content: clip(`${summary}${bullets ? `\n${bullets}` : ""}\n\nFull report attached.`),
            files: [new AttachmentBuilder(Buffer.from(report.full, "utf8"), { name: `${task.id}-turn${task.turns}.md` })],
            allowedMentions: { parse: [] },
          });
        }
        break;
      }
      case "failed":
        await target.channel.send({ content: clip(`${prefix}**Failed:** ${task.error ?? "unknown error"}`), allowedMentions: { parse: [] } });
        break;
      case "needs_input": {
        const pending = task.pendingPermission;
        const options = pending?.options.map((o) => `\`${o.id}\` ${o.name}`).join(" · ") ?? "";
        await target.channel.send({
          content: clip(`${prefix}**Needs permission:** ${pending?.question ?? "unknown action"}\nOptions: ${options}\n(Answer by voice.)`),
          allowedMentions: { parse: [] },
        });
        break;
      }
    }
  }
}

function brief(task: Task, withId: boolean): string {
  const settings = Object.entries(task.settings)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return [
    `${withId ? `**${task.id} · ${task.title}**\n` : ""}**Goal:** ${task.goal}`,
    `**Agent:** ${task.worker}${settings ? ` (${settings})` : ""} · **Folder:** \`${task.cwd}\``,
  ].join("\n");
}

export function renderStatus(task: Task): string {
  const elapsed = Math.round((task.updatedAt - task.createdAt) / 1000);
  const lines = [
    `${STATUS_ICON[task.status]} **${task.id} ${task.status.replace("_", " ")}** · ${task.tools.length} tool calls · ${formatDuration(elapsed)}`,
  ];
  if (task.settings.model) lines.push(`-# ${Object.values(task.settings).join(" · ")}`);
  if (task.plan.length) lines.push("**Plan**", ...task.plan.slice(0, 12).map((p) => `- ${p}`));
  const recent = task.tools.slice(-8);
  if (recent.length) lines.push("**Recent actions**", ...recent.map((t) => `- ${t.title.slice(0, 150)}${t.status ? ` · ${t.status}` : ""}`));
  if (task.error && task.status === "failed") lines.push(`**Error:** ${task.error}`);
  return clip(lines.join("\n"));
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m ${seconds % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function clip(text: string): string {
  return text.length <= MAX_MESSAGE ? text : `${text.slice(0, MAX_MESSAGE - 1)}…`;
}
