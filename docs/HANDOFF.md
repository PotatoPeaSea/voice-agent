# Handoff

Rewritten 2026-10-16 (the 2026-09-29 version described items that are now done). For the person or session picking
up work next. The prioritized backlog is [IMPROVEMENTS.md](IMPROVEMENTS.md); this file is the map and the gotchas.

## Where things stand

Working and in use: Discord voice under DAVE E2EE, STT (Deepgram Flux) → LLM (DeepSeek, OpenAI-compatible) → TTS (local
Qwen3-TTS with DashScope fallback) with barge-in, listen modes, voices, prompts; Claude Code agents over ACP (Hermes
adapter exists but is off by default, see below); Discord thread reports; tasks persisted across restarts with ACP
`session/resume`; direct lookups, MCP servers, `quick_agent`, background jobs, hold music, songs; `run_command`,
`write_file`, Discord tools, reminders, shared memory client, read-only Google Workspace. Typecheck and all tests pass.

Just added, **not yet tried live with a real model**: `run_script` (code mode) and `find_tools` (tool search). See
IMPROVEMENTS items 1 and 2 for what to verify.

Known loose ends:
- Hermes (`HERMES_ACP_COMMAND`) is off: its Groq model returns 413 for Hermes's prompt size, and on DeepSeek a task hung
  until the ACP connection closed.
- Shared memory (docs/MEMORY.md): `scripts/deploy-memory-potatoserver.sh` still has to be run by the user; fact
  extraction is off; Hermes is not wired to it.
- Reminders live in memory only and are lost on restart.
- Every task is visible to every user (`list_tasks`), and task notices go to whoever spoke last (item 5, multi-user).

## Architecture map

- **`src/main.ts`**: entry point. Builds the toolbox, the task registry and workers, joins the voice channel, creates a
  `VoiceSession` per speaking user, slash commands (`/join /leave /newchat /voice /prompt /mode`), shutdown.
- **`src/orchestrator/session.ts`** (`VoiceSession`): one user's loop. STT turns → `assistantTurn` (`turn.ts`, the tool
  loop, shared with `npm run chat`) → sentences (`sentences.ts`) → TTS → `Speaker`. Barge-in aborts the turn.
  Background results arrive through `notify()` and are queued until the conversation is idle.
- **`src/orchestrator/toolbox.ts`**: assembles every tool set the front model gets (`ToolSet` in `toolset.ts`; add a
  capability by writing one and adding it to `combineTools(...)`). Tiers: direct lookups (`lookup-tools.ts`, MCP in
  `src/lookup/mcp.ts`), `quick_agent` (`quick-agent.ts`) with `run_script` (`code-mode.ts`, sandbox in
  `src/sandbox/script.ts`), and the agent tools (`tools.ts`: `dispatch_task` and friends). `background.ts` moves slow
  calls to the background. `find-tools.ts` is tool search over MCP servers marked `core: false`.
- **`src/workers/`**: `acp.ts` (`AcpWorker`, shared ACP plumbing), `claude-acp.ts`, `hermes-acp.ts`.
- **`src/tasks/`**: registry (persisted to `data/tasks/registry.json`), brief/report building and parsing, notices.
- **`src/bot/`**: Discord side: listener, speaker, hold music, task reports in threads.
- **`src/speech/`**: provider-agnostic STT/TTS with a registry (`registerStt` / `registerTts`) and voice-profile fallback.
  Providers without built-in turn detection must pair with a VAD (matters for item 3, local STT).
- **`config/`**: `voices.yaml`, `mcp.yaml`. **`docs/`**: this file, IMPROVEMENTS.md, MEMORY.md. **`issues/`**: bug notes
  with their resolutions.

## Conventions worth keeping

- **Provider registry pattern**: one file per STT/TTS provider, registers itself on import, throws in its factory if a
  required key is missing.
- **Tool sets read live**: `definitions` is a getter so MCP tools and `find_tools` activations show up on the next model call.
- **Report marker**: worker prompts end with `REPORT_INSTRUCTIONS` asking for a `VOICE SUMMARY:` section; `parseReport`
  falls back to the first sentence.
- **Task ids** (`t1`, `t2`, ...) are short so they are easy to say and hear.
- **Safety stance**: tools that change things either need a confirmation in a later reply (enforced in code, `confirm.ts`)
  or are agents with permission prompts. Read-only tools may run without asking. Code-mode scripts only get read-only tools.
- **Commits**: no Claude attribution trailer, ever (user instruction; see CLAUDE.md).
