import { getQuickJS, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";
import { errorMessage, truncate } from "../orchestrator/toolset.js";

export interface ScriptLimits {
  /** Wall-clock budget for the whole script, tool calls included. */
  timeoutMs: number;
  memoryBytes: number;
  stackBytes: number;
  /** Tool calls a single script may make. */
  maxToolCalls: number;
  /** The returned value and console output are cut to this many characters. */
  maxOutputChars: number;
}

export const DEFAULT_LIMITS: ScriptLimits = {
  timeoutMs: 60_000,
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 512 * 1024,
  maxToolCalls: 25,
  maxOutputChars: 6000,
};

/** Calls a tool by name with parsed arguments and returns whatever it returned. */
export type ScriptToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface ScriptResult {
  /** The script's return value as JSON (or text), cut to the output limit. */
  output?: string;
  /** What the script printed with console.log. */
  logs?: string;
  error?: string;
  toolCalls: number;
}

/** Runs inside the VM: `tools.name({...})` goes out through __call, and a tool error becomes a thrown Error. */
const PRELUDE = `
const __logs = [];
globalThis.console = { log: (...a) => __logs.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")) };
globalThis.__logs = __logs;
globalThis.tools = new Proxy({}, {
  get: (_, name) => async (args) => {
    const raw = await __call(String(name), JSON.stringify(args === undefined ? {} : args));
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value.error === "string") throw new Error(name + ": " + value.error);
    return value;
  },
});
`;

/**
 * Run a model-written script in a QuickJS (WebAssembly) VM. The script is the body of an async
 * function: it can `await tools.some_tool({...})` and `return` a value, and has no other way out:
 * no filesystem, network, process or timers, only the tools it is handed. Memory, stack, time
 * and tool-call count are capped.
 */
export async function runScript(code: string, call: ScriptToolCaller, limits: Partial<ScriptLimits> = {}, signal?: AbortSignal): Promise<ScriptResult> {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(lim.memoryBytes);
  runtime.setMaxStackSize(lim.stackBytes);
  const deadline = Date.now() + lim.timeoutMs;
  // Stops a script that spins in guest code (while(true)); time spent waiting on tools is covered by the timer below.
  runtime.setInterruptHandler(() => Date.now() > deadline || signal?.aborted === true);
  const vm = runtime.newContext();
  let toolCalls = 0;
  let finished = false;
  const pending = new Set<Promise<unknown>>();
  const deferreds = new Set<{ dispose(): void; alive: boolean }>();
  let settledHandle: QuickJSHandle | undefined;
  let promiseHandle: QuickJSHandle | undefined;

  const fail = (message: string): ScriptResult => ({ error: message, toolCalls });
  try {
    const callFn = vm.newFunction("__call", (nameHandle, argsHandle) => {
      // The guest handles are only valid inside this callback, so read them before anything awaits.
      const name = vm.getString(nameHandle);
      const rawArgs = vm.getString(argsHandle);
      const promise = vm.newPromise();
      deferreds.add(promise);
      const settle = async () => {
        try {
          if (++toolCalls > lim.maxToolCalls) throw new Error(`more than ${lim.maxToolCalls} tool calls in one script`);
          const args = JSON.parse(rawArgs) as Record<string, unknown>;
          const value = await call(name, args && typeof args === "object" && !Array.isArray(args) ? args : {});
          return JSON.stringify(value ?? null);
        } catch (err) {
          return JSON.stringify({ error: errorMessage(err) });
        }
      };
      const work = settle().then((json) => {
        if (finished || !vm.alive) return;
        const text = vm.newString(json);
        promise.resolve(text);
        text.dispose();
        runtime.executePendingJobs();
      });
      pending.add(work);
      void work.finally(() => pending.delete(work));
      return promise.handle;
    });
    vm.setProp(vm.global, "__call", callFn);
    callFn.dispose();
    vm.unwrapResult(vm.evalCode(PRELUDE, "prelude.js")).dispose();

    const evaluated = vm.evalCode(`(async () => {\n${code}\n})()`, "script.js");
    if (evaluated.error) return fail(describe(vm, evaluated.error));
    promiseHandle = evaluated.value;
    runtime.executePendingJobs();

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()))));
    const aborted = new Promise<"abort">((resolve) => signal?.addEventListener("abort", () => resolve("abort"), { once: true }));
    const resolving = vm.resolvePromise(promiseHandle);
    // A script that never calls a tool has no host callback to run its pending jobs, so run them here.
    runtime.executePendingJobs();
    const settled = await Promise.race([resolving, timedOut, aborted]);
    clearTimeout(timer);
    if (settled === "timeout") return fail(`script timed out after ${lim.timeoutMs / 1000}s`);
    if (settled === "abort") return fail("cancelled");
    if (settled.error) return fail(describe(vm, settled.error));

    settledHandle = settled.value;
    const value = vm.dump(settledHandle);
    const logsHandle = vm.getProp(vm.global, "__logs");
    const logs = vm.dump(logsHandle) as string[];
    logsHandle.dispose();
    const output = value === undefined ? undefined : truncate(typeof value === "string" ? value : JSON.stringify(value), lim.maxOutputChars);
    return {
      ...(output === undefined ? {} : { output }),
      ...(logs.length ? { logs: truncate(logs.join("\n"), lim.maxOutputChars) } : {}),
      toolCalls,
    };
  } catch (err) {
    return fail(errorMessage(err));
  } finally {
    finished = true;
    // Let tool calls still in flight settle before the VM goes away.
    await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 100))]);
    try {
      // The runtime asserts that nothing is still alive when it is freed, so release every handle first.
      settledHandle?.dispose();
      if (promiseHandle?.alive) promiseHandle.dispose();
      for (const d of deferreds) if (d.alive) d.dispose();
      vm.dispose();
      runtime.dispose();
    } catch {
      // A handle was still held by something abandoned mid-flight; the VM is garbage-collected with the process.
    }
  }
}

function describe(vm: QuickJSContext, handle: QuickJSHandle): string {
  const error = vm.dump(handle) as { name?: string; message?: string } | string;
  handle.dispose();
  if (typeof error === "string") return error;
  const message = error?.message ?? JSON.stringify(error);
  return /interrupted/i.test(message) ? "script ran too long (interrupted)" : message;
}
