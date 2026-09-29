import type { TaskRegistry } from "../tasks/registry.js";
import type { TaskSettings } from "../tasks/types.js";
import { AcpWorker, acpErrorMessage, type AcpWorkerOptions, type ModelState, type SessionInfo, type SessionState } from "./acp.js";
import type { WorkerSetting } from "./types.js";

/**
 * Hermes Agent as a worker, via its ACP server (`hermes-acp`, or `hermes acp`).
 * Unlike Claude Code it has no config options: the model is chosen with
 * Hermes's session/set_model (provider:model ids from its own inventory) and
 * the edit-approval policy is an ACP session mode. It has no effort or fast mode.
 */
export class HermesAcpWorker extends AcpWorker {
  readonly name = "hermes";
  private readonly launch: string[];

  constructor(registry: TaskRegistry, log: (...a: unknown[]) => void, options: AcpWorkerOptions & { command?: string } = {}) {
    super(registry, log, options);
    this.launch = (options.command ?? "hermes-acp").split(/\s+/).filter(Boolean);
  }

  protected command() {
    const [cmd, ...args] = this.launch;
    return { cmd: cmd!, args };
  }

  protected async applySettings(state: SessionState, settings: TaskSettings): Promise<{ current: TaskSettings; ignored: string[] }> {
    const ignored: string[] = [];
    if (settings.model) {
      const models = state.info.models;
      const modelId = models ? matchModel(models, settings.model) : settings.model;
      if (!modelId) {
        throw new Error(`Hermes has no model matching "${settings.model}". See agent_options for the list.`);
      }
      if (this.isBlocked(modelId)) throw new Error(`Model "${modelId}" is blocked by configuration.`);
      try {
        await this.connection!.extMethod("session/set_model", { sessionId: state.sessionId, modelId });
      } catch (err) {
        throw new Error(`Couldn't set model=${modelId}: ${acpErrorMessage(err)}`);
      }
      if (models) models.currentModelId = modelId;
      this.registry.log(state.task, `set model=${modelId}`);
    }
    if (settings.mode) {
      const modes = state.info.modes;
      const wanted = normalize(settings.mode);
      const mode = modes?.availableModes.find((m) => normalize(m.id) === wanted || normalize(m.name) === wanted);
      if (!modes || !mode) {
        ignored.push(`mode ${settings.mode} (Hermes modes: ${modes?.availableModes.map((m) => m.id).join(", ") ?? "none"})`);
      } else {
        try {
          await this.connection!.setSessionMode({ sessionId: state.sessionId, modeId: mode.id });
        } catch (err) {
          throw new Error(`Couldn't set mode=${mode.id}: ${acpErrorMessage(err)}`);
        }
        modes.currentModeId = mode.id;
        this.registry.log(state.task, `set mode=${mode.id}`);
      }
    }
    if (settings.effort) ignored.push("effort (Hermes has no effort setting)");
    if (settings.fast) ignored.push("fast (Hermes has no fast mode)");
    this.lastInfo = state.info;
    return { current: currentSettings(state.info), ignored };
  }

  protected describeSettings(info: SessionInfo): WorkerSetting[] {
    const settings: WorkerSetting[] = [];
    if (info.models) {
      settings.push({
        id: "model",
        name: "Model",
        current: info.models.currentModelId,
        choices: info.models.availableModels
          .filter((m) => !this.isBlocked(m.modelId))
          .map((m) => ({ value: m.modelId, description: m.description ?? undefined })),
      });
    }
    if (info.modes) {
      settings.push({
        id: "mode",
        name: "Edit approval",
        current: info.modes.currentModeId,
        choices: info.modes.availableModes.map((m) => ({ value: m.id, description: m.description ?? undefined })),
      });
    }
    return settings;
  }
}

function currentSettings(info: SessionInfo): TaskSettings {
  const current: TaskSettings = {};
  if (info.models?.currentModelId) current.model = info.models.currentModelId;
  if (info.modes?.currentModeId) current.mode = info.modes.currentModeId;
  return current;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Find the model the user meant among Hermes's "provider:model" ids. Spoken names
 * ("sonnet 5") match loosely; an exact id always wins, then the current provider,
 * then the shortest (most specific) id.
 */
export function matchModel(models: ModelState, spoken: string): string | undefined {
  const exact = models.availableModels.find((m) => m.modelId === spoken || m.modelId.split(":").slice(1).join(":") === spoken);
  if (exact) return exact.modelId;
  const wanted = normalize(spoken);
  if (!wanted) return undefined;
  const provider = models.currentModelId.split(":")[0];
  const candidates = models.availableModels.filter((m) => normalize(m.modelId).includes(wanted) || normalize(m.name).includes(wanted));
  candidates.sort(
    (a, b) =>
      Number(b.modelId.startsWith(`${provider}:`)) - Number(a.modelId.startsWith(`${provider}:`)) || a.modelId.length - b.modelId.length,
  );
  return candidates[0]?.modelId;
}
