import type { Env } from "../config.js";
import type { TaskRegistry } from "../tasks/registry.js";
import { ClaudeAcpWorker } from "./claude-acp.js";
import { HermesAcpWorker } from "./hermes-acp.js";
import type { WorkerAdapter } from "./types.js";

/** Every worker enabled by the environment: Claude Code always, Hermes when HERMES_ACP_COMMAND is set. */
export function makeWorkers(env: Env, registry: TaskRegistry, log: (...a: unknown[]) => void): WorkerAdapter[] {
  const workers: WorkerAdapter[] = [
    new ClaudeAcpWorker(registry, log, {
      defaults: { model: env.CLAUDE_MODEL, effort: env.CLAUDE_EFFORT, mode: env.CLAUDE_MODE },
      blockedModels: env.CLAUDE_BLOCKED_MODELS,
    }),
  ];
  if (env.HERMES_ACP_COMMAND.toLowerCase() !== "off") {
    workers.push(
      new HermesAcpWorker(registry, log, {
        command: env.HERMES_ACP_COMMAND,
        defaults: { model: env.HERMES_MODEL, mode: env.HERMES_MODE },
        blockedModels: env.CLAUDE_BLOCKED_MODELS,
      }),
    );
  }
  return workers;
}
