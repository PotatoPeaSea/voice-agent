# Improvements backlog

Ordered by priority. Pick from the top once v1 (milestones 0–5) is working.

## 1. Claude Code worker adapter (first improvement after v1)
v1 dispatches all work to Hermes Agent. Add a Claude Code worker behind the same
`WorkerAdapter` interface (`src/workers/`) so the orchestrator can choose per task.
- Use the Claude Agent SDK (TypeScript) or headless `claude -p --output-format stream-json`.
- Map session resume to follow-ups and blocking questions (`send_followup`, `answer_question`).
- Produce the same tiered report (headline / summary / questions / artifacts).
- Add a routing hint to the orchestrator: e.g. heavy coding -> Claude Code, research/automation -> Hermes.

## 2. Local STT/TTS on the Linux workstation
Self-host faster-whisper (STT) and Kokoro/Piper (TTS) under `services/`, registered as providers.
Keep cloud providers configured as automatic failover.

## 3. Speech-to-speech front end (optional)
Evaluate a realtime speech-to-speech model as an alternative front desk for lower latency,
keeping the same tool set for dispatching workers.

## 4. Multi-user support
Per-user conversation state, per-user allowlists and project roots.
