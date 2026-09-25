# Improvements backlog

Ordered by priority. Pick from the top.

## 1. Hermes Agent worker adapter
Claude Code (via ACP, `src/workers/claude-acp.ts`) is the first worker. Add Hermes Agent behind the
same `WorkerAdapter` interface (`src/workers/types.ts`) so the orchestrator can choose per task.
- Hermes exposes `hermes serve` (JSON-RPC/WebSocket) and may speak ACP directly; prefer ACP if so,
  since the Claude worker's session/permission/report handling could then be reused.
- Produce the same tiered report (headline / bullets / full).
- Add a `worker` parameter to `dispatch_task` and a routing hint in the system prompt.

## 2. Task reports in Discord text
Post each task's full report and live tool activity to a Discord thread, so diffs and logs are
readable while the voice channel only gets headlines.

## 3. Persist tasks across restarts
Tasks live in memory (logs are on disk in data/tasks). Persist the registry and use ACP
`session/resume` to reattach to Claude Code sessions after a restart.

## 4. Local STT on the Linux workstation
Self-host a streaming STT with turn detection, registered as a provider, with Deepgram as fallback.

## 5. Speech-to-speech front end (optional)
Evaluate a realtime speech-to-speech model as an alternative front desk for lower latency,
keeping the same tool set.

## 6. Multi-user support
Per-user conversation state, allowlists and project roots.
