import type { ToolContext } from "./tools.js";

/** A pending action is forgotten after this long. */
const TTL_MS = 5 * 60_000;

const AFFIRMATIVE = /\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|go for it|do it|run it|send it|confirm|confirmed|please do|sounds good|that's fine|go on)\b/i;
const NEGATIVE = /\b(no|nope|nah|don'?t|do not|stop|cancel|wait|hold on|never ?mind|not yet|abort)\b/i;

interface Entry<T> {
  payload: T;
  /** Which user turn proposed it; only a later turn can confirm it. */
  turn: number;
  transcript: string;
  at: number;
}

export type Taken<T> = { ok: true; payload: T } | { ok: false; error: string };

/**
 * Actions the model proposes but may only carry out after the USER says yes in a later turn. The check is
 * here, not in the prompt: a model that was told by a web page or file to approve its own action finds
 * the same turn can't confirm, and a reply that isn't a yes drops the action.
 */
export class Confirmations<T> {
  private readonly pending = new Map<string, Entry<T>>();
  private next = 1;

  constructor(private readonly prefix: string) {}

  /** Park an action; returns the id the model must pass back after the user agrees. */
  propose(payload: T, ctx: ToolContext): string {
    const now = Date.now();
    for (const [id, entry] of this.pending) if (now - entry.at > TTL_MS) this.pending.delete(id);
    const id = `${this.prefix}${this.next++}`;
    this.pending.set(id, { payload, turn: ctx.userTurn ?? -1, transcript: ctx.userTranscript, at: now });
    return id;
  }

  /** The parked action, if the user has answered yes since it was proposed. Single use. */
  take(id: string, ctx: ToolContext): Taken<T> {
    const entry = this.pending.get(id);
    if (!entry) return { ok: false, error: `Nothing is waiting under "${id}" (it may have expired or already happened). Propose it again.` };
    if (Date.now() - entry.at > TTL_MS) {
      this.pending.delete(id);
      return { ok: false, error: "That expired. Propose it again." };
    }
    const sameTurn = ctx.userTurn !== undefined ? ctx.userTurn <= entry.turn : ctx.userTranscript === entry.transcript;
    if (sameTurn) return { ok: false, error: "The user hasn't answered yet. Say in plain words what you're about to do, ask if you should, and wait for their reply." };
    if (NEGATIVE.test(ctx.userTranscript) && !AFFIRMATIVE.test(ctx.userTranscript)) {
      this.pending.delete(id);
      return { ok: false, error: "The user's reply wasn't a yes, so it was dropped. Don't do it." };
    }
    this.pending.delete(id);
    return { ok: true, payload: entry.payload };
  }
}
