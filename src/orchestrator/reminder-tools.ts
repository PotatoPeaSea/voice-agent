import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolContext } from "./tools.js";
import { parseArgs, toolName, type ToolSet } from "./toolset.js";

/** Reminders live in memory (they're lost on restart), so they're capped at a day. */
const MAX_DELAY_MS = 24 * 60 * 60_000;
const MAX_REMINDERS = 20;

export const REMINDER_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "set_reminder",
      description:
        "Set a reminder you'll speak up with later while the bot is running (e.g. \"remind me in 20 minutes to check the oven\", \"remind me at 5 pm to call mom\"). " +
        "Give either in_minutes or at (a time today or tomorrow as HH:MM, 24-hour, the user's local time). Up to 24 hours ahead; reminders don't survive a restart of the bot.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to remind the user about, as you'd say it to them." },
          in_minutes: { type: "number", description: "Minutes from now." },
          at: { type: "string", description: "Clock time HH:MM (24-hour). If that time already passed today, it means tomorrow." },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_reminders",
      description: "List the reminders that are set and when they'll go off.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_reminder",
      description: "Cancel a reminder by its id from list_reminders, or all of them.",
      parameters: { type: "object", properties: { id: { type: "string", description: 'Reminder id, or "all".' } }, required: ["id"] },
    },
  },
];

const NAMES = new Set(REMINDER_TOOL_DEFINITIONS.map(toolName));

interface Reminder {
  id: string;
  text: string;
  at: number;
  timer: NodeJS.Timeout;
}

/** When `HH:MM` next occurs, in the same local time zone as `now`. */
export function nextClockTime(hhmm: string, now: Date): Date | undefined {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(hhmm);
  if (!m) return undefined;
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (h > 23 || min > 59) return undefined;
  const target = new Date(now);
  target.setHours(h, min, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target;
}

const clock = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/** Reminders the bot speaks up with later, delivered like any automatic update. */
export class ReminderTools implements ToolSet {
  readonly definitions = REMINDER_TOOL_DEFINITIONS;
  private readonly reminders = new Map<string, Reminder>();
  private next = 1;

  constructor(
    private readonly log: (...a: unknown[]) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  handles(name: string): boolean {
    return NAMES.has(name);
  }

  /** Cancel every pending timer (when the bot shuts down). */
  dispose(): void {
    for (const r of this.reminders.values()) clearTimeout(r.timer);
    this.reminders.clear();
  }

  execute(name: string, rawArgs: string, ctx: ToolContext): unknown {
    const args = parseArgs(rawArgs);
    if (typeof args === "string") return { error: args };
    switch (name) {
      case "set_reminder": {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) return { error: "say what to remind them about" };
        if (!ctx.notify) return { error: "Reminders aren't available here (nobody to tell later)." };
        const now = this.now();
        let when: Date | undefined;
        if (typeof args.at === "string" && args.at.trim()) {
          when = nextClockTime(args.at, now);
          if (!when) return { error: `"${args.at}" isn't a time. Use HH:MM, 24-hour.` };
        } else if (Number.isFinite(Number(args.in_minutes)) && Number(args.in_minutes) > 0) {
          when = new Date(now.getTime() + Number(args.in_minutes) * 60_000);
        } else {
          return { error: "give in_minutes or at" };
        }
        const delay = when.getTime() - now.getTime();
        if (delay > MAX_DELAY_MS) return { error: "That's more than a day away; reminders don't survive a restart, so keep them under 24 hours." };
        if (this.reminders.size >= MAX_REMINDERS) return { error: "Too many reminders are set. Cancel some first." };
        const id = `r${this.next++}`;
        const notify = ctx.notify;
        const timer = setTimeout(() => {
          this.reminders.delete(id);
          this.log(`reminder ${id} fired: ${text}`);
          notify(`Reminder the user asked for: ${text}. Tell them now, briefly.`);
        }, delay);
        timer.unref?.();
        this.reminders.set(id, { id, text, at: when.getTime(), timer });
        this.log(`reminder ${id} set for ${when.toISOString()}: ${text}`);
        return { ok: true, id, text, goes_off_at: clock(when), in_minutes: Math.round(delay / 60_000) };
      }
      case "list_reminders":
        return {
          reminders: [...this.reminders.values()]
            .sort((a, b) => a.at - b.at)
            .map((r) => ({ id: r.id, text: r.text, goes_off_at: clock(new Date(r.at)) })),
        };
      case "cancel_reminder": {
        const id = typeof args.id === "string" ? args.id.trim().toLowerCase() : "";
        const targets = id === "all" ? [...this.reminders.values()] : this.reminders.has(id) ? [this.reminders.get(id)!] : [];
        if (!targets.length) return { error: id === "all" ? "There are no reminders." : `No reminder "${id}". Use list_reminders.` };
        for (const r of targets) {
          clearTimeout(r.timer);
          this.reminders.delete(r.id);
        }
        return { ok: true, cancelled: targets.map((r) => r.text) };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  }
}
