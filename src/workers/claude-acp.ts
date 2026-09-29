import { createRequire } from "node:module";
import type * as acp from "@agentclientprotocol/sdk";
import type { TaskSettings } from "../tasks/types.js";
import { AcpWorker, acpErrorMessage, type SessionInfo, type SessionState } from "./acp.js";
import type { WorkerSetting } from "./types.js";

const require = createRequire(import.meta.url);
const SETTING_IDS = ["model", "effort", "mode", "fast"] as const;

/**
 * Claude Code as a worker, via @agentclientprotocol/claude-agent-acp. Its model,
 * effort, permission mode and fast mode are ACP session config options.
 */
export class ClaudeAcpWorker extends AcpWorker {
  readonly name = "claude-code";

  protected command() {
    return { cmd: process.execPath, args: [require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")] };
  }

  protected async applySettings(state: SessionState, settings: TaskSettings): Promise<{ current: TaskSettings; ignored: string[] }> {
    const ignored: string[] = [];
    // Model first: it decides which other options exist (Haiku has no effort; fast mode is model-specific).
    for (const id of SETTING_IDS) {
      const value = settings[id];
      if (value === undefined) continue;
      const options = state.info.configOptions ?? [];
      if (!options.some((o) => o.id === id)) {
        ignored.push(`${id} (not supported by model ${currentValue(options, "model") ?? "?"})`);
        continue;
      }
      try {
        const response = await this.connection!.setSessionConfigOption({ sessionId: state.sessionId, configId: id, value });
        state.info.configOptions = response.configOptions;
        this.lastInfo = state.info;
        this.registry.log(state.task, `set ${id}=${value}`);
      } catch (err) {
        throw new Error(`Couldn't set ${id}=${value}: ${acpErrorMessage(err)}`);
      }
    }
    const current: TaskSettings = {};
    for (const option of state.info.configOptions ?? []) {
      if ((SETTING_IDS as readonly string[]).includes(option.id)) {
        current[option.id as keyof TaskSettings] = String(option.currentValue);
      }
    }
    return { current, ignored };
  }

  protected describeSettings(info: SessionInfo): WorkerSetting[] {
    return (info.configOptions ?? [])
      .filter((o) => (SETTING_IDS as readonly string[]).includes(o.id) && o.type === "select")
      .map((o) => {
        const select = o as acp.SessionConfigOption & { type: "select"; options: acp.SessionConfigSelectOptions };
        const flat = select.options
          .flatMap((x) => ("options" in x ? x.options : [x]))
          .filter((c) => o.id !== "model" || !(this.isBlocked(c.value) || this.isBlocked(c.name)));
        return {
          id: o.id,
          name: o.name,
          current: String(o.currentValue),
          choices: flat.map((c) => ({ value: c.value, description: c.description ?? undefined })),
        };
      });
  }
}

function currentValue(options: acp.SessionConfigOption[], id: string): string | undefined {
  const option = options.find((o) => o.id === id);
  return option ? String(option.currentValue) : undefined;
}
