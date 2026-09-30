import type { ToolContext } from "./tools.js";
import { errorMessage, truncate, type ToolSet } from "./toolset.js";

const MAX_NOTICE_RESULT = 6000;

export interface BackgroundJobsOptions {
  /** How long a tool call may take before the turn moves on and the call finishes in the background. */
  waitMs: number;
  /** Background calls are abandoned after this long. */
  timeoutMs: number;
  log: (...a: unknown[]) => void;
  /** Called when a background call finishes (before its result is queued for the user). */
  onFinish?: () => void;
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Keeps slow lookups from holding up the conversation: a call that hasn't
 * answered within the wait carries on in the background, the model is told so
 * (and can say "I'll get back to you"), and the result arrives later as an
 * automatic update through ToolContext.notify.
 */
export class BackgroundJobs {
  private next = 1;
  private readonly running = new Map<string, string>(); // job id -> label

  constructor(private readonly opts: BackgroundJobsOptions) {}

  /** Calls still running in the background. */
  get active(): number {
    return this.running.size;
  }

  /** The same tools, with every call subject to the wait (or `waitMs` for tools known to be slow). */
  wrap(set: ToolSet, waitMs = this.opts.waitMs): ToolSet {
    return {
      get definitions() {
        return set.definitions;
      },
      handles: (name) => set.handles(name),
      execute: (name, args, ctx) =>
        this.run(`${name}(${args.length > 120 ? `${args.slice(0, 120)}…` : args})`, ctx, (signal) => set.execute(name, args, { ...ctx, signal }), waitMs),
    };
  }

  async run(label: string, ctx: ToolContext, work: (signal: AbortSignal) => unknown, waitMs = this.opts.waitMs): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`timed out after ${this.opts.timeoutMs / 1000}s`)), this.opts.timeoutMs);
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }),
    );
    const outcome: Promise<Outcome> = Promise.race([Promise.resolve().then(() => work(controller.signal)), aborted])
      .then((value): Outcome => ({ ok: true, value }), (err): Outcome => ({ ok: false, error: errorMessage(err) }))
      .finally(() => clearTimeout(timeout));

    // Nobody to tell later (e.g. inside the quick agent): just wait.
    if (!ctx.notify) return settle(await outcome);

    let waitTimer: NodeJS.Timeout | undefined;
    const early = await Promise.race([
      outcome,
      new Promise<undefined>((resolve) => (waitTimer = setTimeout(() => resolve(undefined), waitMs))),
    ]);
    clearTimeout(waitTimer);
    if (early) return settle(early);

    const id = `j${this.next++}`;
    const notify = ctx.notify;
    this.running.set(id, label);
    this.opts.log(`job ${id} ${label} continues in the background`);
    void outcome.then((result) => {
      this.running.delete(id);
      this.opts.log(`job ${id} ${result.ok ? "finished" : `failed: ${result.error}`}`);
      this.opts.onFinish?.();
      notify(describe(id, label, result));
    });
    return {
      status: "running_in_background",
      job_id: id,
      note: "Working on it in the background. Briefly tell the user you'll let them know, then carry on; the result arrives as an automatic update.",
    };
  }
}

function settle(outcome: Outcome): unknown {
  return outcome.ok ? outcome.value : { error: outcome.error };
}

function describe(id: string, label: string, outcome: Outcome): string {
  if (!outcome.ok) return `Background lookup ${id} ${label} failed: ${outcome.error}`;
  const value = outcome.value as { error?: unknown } | undefined;
  const result = truncate(JSON.stringify(outcome.value ?? null), MAX_NOTICE_RESULT);
  return `Background lookup ${id} ${label} ${value && typeof value === "object" && "error" in value ? "failed" : "finished"}. Result: ${result}`;
}
