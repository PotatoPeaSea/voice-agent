# Handoff: remaining backlog items

Written 2026-09-29, against commit `2d73fc9`. For the person or session picking up work next.
Each section below is a starting point for one item in [IMPROVEMENTS.md](IMPROVEMENTS.md), with the
interfaces, files and gotchas you'd otherwise have to re-derive from the code. Nothing here is a
promise that the approach is right — verify assumptions marked "unverified" before relying on them.

## Where things stand

M0 (Discord voice under DAVE E2EE) and Claude Code agents over ACP are verified end to end
(`npm run chat`). M1 (the full voice loop: STT → LLM → TTS with barge-in) is built but has not had
a live test with real API keys yet — that's worth doing before trusting any of the latency-sensitive
work below. Qwen3-TTS (local GPU + DashScope cloud fallback) is wired in and active.

## Architecture map

- **`src/main.ts`** — entry point. Wires one `TaskRegistry`, one `WorkerAdapter` (currently only
  `ClaudeAcpWorker`), one `TaskTools`, joins the voice channel, creates a `VoiceSession` per speaking
  Discord user (keyed by `userId` in the `sessions` map), retries joins, cleans up on shutdown.
- **`src/orchestrator/session.ts`** (`VoiceSession`) — one user's conversation loop: opens an STT
  stream on `wake()`, turns `turn_end` events into LLM replies (`assistantTurn` in `turn.ts`), chunks
  the LLM's streamed tokens into sentences (`sentences.ts`), feeds those to TTS (`speak()`), plays
  the resulting PCM through `Speaker`, and handles barge-in by aborting the in-flight turn. Background
  task events arrive via `notify()` and are queued until the conversation is idle (`flushNotices`).
- **`src/speech/`** — provider-agnostic STT/TTS. `types.ts` defines `SttProvider`/`TtsProvider`;
  `registry.ts` is the name → factory map; `index.ts` wires env-based options and voice-profile
  fallback (`fallback.ts`, `voices.ts`). Adding a provider = one file that calls `registerStt`/
  `registerTts`, plus an import in `speech/index.ts`.
- **`src/workers/`** — coding-agent adapters. `types.ts` defines `WorkerAdapter`; `claude-acp.ts` is
  the only implementation, spawning `@agentclientprotocol/claude-agent-acp` as a child process and
  speaking ACP over its stdio.
- **`src/tasks/`** — `registry.ts` (in-memory `Map<id, Task>`, appends to `data/tasks/<id>.log` and
  writes `data/tasks/<id>.md` on each report), `types.ts` (the `Task`/`TaskEvent` shapes),
  `report.ts` (`buildBrief` builds the worker prompt; `parseReport` extracts the spoken
  headline/bullets from the agent's `VOICE SUMMARY:` marker), `notices.ts` (`describeEvent` turns a
  `TaskEvent` into text the front model reads back).
- **`src/orchestrator/tools.ts`** (`TaskTools`) — executes the front LLM's tool calls
  (`dispatch_task`, `list_tasks`, `get_task`, `send_to_task`, `configure_task`, `answer_permission`,
  `cancel_task`, `list_projects`, `agent_options`) against one `WorkerAdapter` and the `TaskRegistry`.

## 1. Hermes Agent worker adapter

Add Hermes behind `WorkerAdapter` (`src/workers/types.ts`) the same way `ClaudeAcpWorker`
(`src/workers/claude-acp.ts`) implements it — that file is the pattern to mirror line for line:
`start`/`send`/`configure`/`answerPermission`/`cancel`/`settings`/`shutdown`, updating the shared
`Task` object through `TaskRegistry.update`/`log`/`saveReport`/`notify` so the rest of the pipeline
(reports, spoken notices, `get_task`) doesn't need to know which worker produced them.

What's changed since IMPROVEMENTS.md was written:
- `HERMES_URL`/`HERMES_TOKEN` env vars that existed in an earlier draft of `.env.example` are **gone
  now** — `src/config.ts` has no Hermes entries. You'll need to add them back (and to
  `EnvSchema`/`.env.example`) once you know Hermes's actual connection details.
- `src/main.ts` currently wires exactly **one** `WorkerAdapter` into `TaskTools`. `dispatch_task`'s
  schema (`src/orchestrator/tools.ts`) has no `worker` parameter yet, and `TaskTools` takes a single
  `worker`, not a map. Routing per task (IMPROVEMENTS.md's item 1) means: add `worker` to
  `TOOL_DEFINITIONS`'s `dispatch_task` properties, change `TaskTools` to hold
  `Map<string, WorkerAdapter>` keyed by adapter `.name`, look the worker up in `dispatch`
  (`src/orchestrator/tools.ts:215`), and store the chosen worker's name on the `Task` (`task.worker`
  already exists in `types.ts` — just needs to be read instead of assumed). Add a routing hint to
  `VOICE_SYSTEM_PROMPT` (`src/orchestrator/prompt.ts`) once there's a second worker to choose from.
- `parseReport`/`REPORT_INSTRUCTIONS` (`src/tasks/report.ts`) assume the worker's final message ends
  with a `VOICE SUMMARY:` marker. If Hermes can't be told to do that in its prompt, you'll need a
  second parse path or a Hermes-specific instruction string.
- **Unverified**: IMPROVEMENTS.md guesses Hermes "may speak ACP directly." If true, a `HermesAcpWorker`
  could reuse most of `claude-acp.ts` (swap the spawn command and adapter). Check
  `hermes serve --help` / its docs before assuming this — if it's JSON-RPC-over-WebSocket instead,
  you're writing the ACP-shaped session/permission/report plumbing again from scratch.

## 2. Task reports in Discord text

Nothing in the codebase currently talks to a Discord text channel — `src/main.ts` only joins voice
(`joinVoiceChannel`). `registry.on("event", ...)` (`src/main.ts:39`) is the only place task events are
currently consumed; today it just calls `lastActive?.notify(text)` for the spoken summary. Add a
second listener there that posts to Discord instead.

Starting points:
- The full report is already on disk at `data/tasks/<id>.md` (written by
  `TaskRegistry.saveReport`, `src/tasks/registry.ts:55`) and in memory at `task.report.full`
  (`src/tasks/types.ts`) — no new parsing needed, just formatting for Discord.
- Live tool activity is on `task.tools` (`ToolActivity[]`, updated by `ClaudeAcpWorker.onUpdate`,
  `src/workers/claude-acp.ts:246`) and `task.plan` — useful for a running thread that updates as the
  agent works, not just a final post.
- You'll need a channel to post into and a place to create per-task threads. Discord voice channels
  in this guild may or may not have an associated text chat depending on your server setup; simplest
  is a dedicated `DISCORD_REPORTS_CHANNEL_ID` env var (add to `EnvSchema`/`.env.example` following the
  pattern of `DISCORD_VOICE_CHANNEL_ID`) and `client.channels.fetch(...)` it once at startup next to
  where `guild` is fetched in `main.ts`.
- Thread-per-task: create the thread on `dispatch` (in `TaskTools.dispatch`,
  `src/orchestrator/tools.ts:215`, or via a `registry.on("event", ...)` handler keyed off task
  creation) and store the thread id somewhere retrievable by `task.id` — `Task` has no field for it
  yet; add one to `src/tasks/types.ts` if you go this route.

## 3. Persist tasks across restarts

`TaskRegistry` (`src/tasks/registry.ts`) is a plain in-memory `Map`; only the append-only `.log` file
and the latest `.md` report per task survive a restart today — the `Task` objects themselves
(status, settings, tool history, pending permissions) do not.

- Serialize the registry: write `data/tasks/registry.json` (all `Task` objects, or enough of them —
  `pendingPermission` and `currentText` are mid-turn state that won't mean anything after a restart)
  on every `update`/`create`, and load it in the `TaskRegistry` constructor.
- Reattaching live sessions is the harder part and is worker-specific. For `ClaudeAcpWorker`
  (`src/workers/claude-acp.ts`), the ACP SDK exposes both `session/load` (`loadSession`, replays
  message history) and `session/resume` (`resumeSession`, resumes without replay) — see
  `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` around line 1033 and 1085. **Unverified**:
  whether `@agentclientprotocol/claude-agent-acp` actually advertises either capability — check
  `init.agentCapabilities` (from the `connection.initialize(...)` call at
  `src/workers/claude-acp.ts:83`) at runtime before assuming resume works. If neither is supported,
  a restart mid-task means the task is unrecoverable and should just be marked `failed` on load.
- On load, tasks that were `running`/`starting`/`needs_input` when the process died need a decision:
  mark them `failed` with an explanit error, or attempt resume if the capability exists. Don't
  silently resurrect them as `idle` — the user will ask `get_task` and get confused by stale state.

## 4. Local STT on the Linux workstation

Mirrors the `qwen-local`/`qwen-cloud` pattern already used for TTS (`src/speech/tts/qwen-local.ts`,
`qwen-cloud.ts`, plus the fallback wiring in `src/speech/fallback.ts` and `config/voices.yaml`) —
worth reading those before starting, since STT should probably get the same local-with-cloud-fallback
shape.

Key constraint, from `src/speech/types.ts`'s own doc comment: **"Providers without built-in turn
detection must pair with a VAD to produce turn_start / turn_end."** `deepgram-flux.ts`
(`src/speech/stt/deepgram-flux.ts`) gets end-of-turn detection for free from Deepgram Flux; most
local/self-hosted STT models won't have that, so a local provider likely needs to pair raw
transcription with a separate voice-activity-detector to synthesize `turn_start`/`partial`/`turn_end`
itself (`SttEvent` in `types.ts`). Audio arrives as 16kHz mono PCM (`STT_RATE` in
`src/audio/pcm.ts`) via `listenToUser()` (`src/bot/listener.ts`) — same input contract regardless of
provider.

`STT_PROVIDER` in `.env`/`EnvSchema` (`src/config.ts`) picks the active provider by registered name,
same mechanism as TTS's `voices.yaml` `provider` field — no new plumbing needed there, just register
the new provider (`registerStt`) and import it in `src/speech/index.ts`.

## 5. Speech-to-speech front end (optional)

This would replace the STT → LLM → TTS split inside `VoiceSession.reply()`
(`src/orchestrator/session.ts:168`) with a single duplex connection to a realtime model (e.g. a Qwen,
OpenAI, or Gemini realtime API) for lower latency, per the comparison discussed earlier in this
project's chat history (cascaded pipeline vs. native speech-to-speech: roughly 700–1500ms vs.
300–600ms end-of-speech-to-first-audio, at the cost of losing per-stage provider choice, custom
voices, and giving tool-calling reliability over to whatever the realtime model supports).

This is the biggest architectural lift of the six items — it doesn't fit cleanly behind the existing
`SttProvider`/`TtsProvider` interfaces, since those assume separable transcription and synthesis
steps. Treat it as a new, parallel path in `VoiceSession` (or a new session class) rather than a third
`SttProvider`/`TtsProvider` implementation. Two things worth reusing as-is regardless of design:
Discord audio is already available as raw PCM in and out (`listenToUser`, `Speaker.play` in
`src/bot/speaker.ts`), and `TaskTools`/`WorkerAdapter` (tool calling into Claude Code/Hermes) is
independent of the voice pipeline, so the realtime model would call the same tools.

Don't start this until M1's live-tested latency numbers are in hand — the cascade may already be
fast enough that this isn't worth the loss of control.

## 6. Multi-user support

Partially done already: `src/main.ts` keys `sessions` by Discord `userId` and each gets its own
`VoiceSession` with independent history/STT/turn state (`connection.receiver.speaking.on("start", ...)`,
`src/main.ts:123`), and `isAllowed()` already gates on `ALLOWED_USER_IDS`. The gaps:

- **Task notifications go to whichever user spoke most recently**, not the user who dispatched the
  task. `lastActive` (`src/main.ts:28`) is a single global `VoiceSession | undefined`, updated on
  every `speaking.on("start")` and read by `registry.on("event", ...)` (`src/main.ts:39-43`). Fix
  means attributing each `Task` to the `userId` that dispatched it (add a field to `Task` in
  `src/tasks/types.ts`, set it in `TaskTools.dispatch`, `src/orchestrator/tools.ts:215` — `ToolContext`
  would need the userId threaded through from `VoiceSession.reply`'s `ctx`) and looking up that
  user's session in `sessions` instead of using `lastActive`.
- **Project roots and permissions are global, not per-user.** `WORKER_ROOTS`/`roots` (`src/main.ts:30`)
  and `ALLOWED_USER_IDS` are both server-wide; there's no per-user allowlist of which project folders
  they can dispatch into. If that matters for your use case, it's a new field alongside
  `ALLOWED_USER_IDS` in `EnvSchema` and a check in `TaskTools.resolveProject`
  (`src/orchestrator/tools.ts:193`).
- **`TaskRegistry`/`TaskTools`/`WorkerAdapter` are shared singletons** across all users
  (`src/main.ts:31-37`) — tasks and their ids (`t1`, `t2`, ...) are visible to every user via
  `list_tasks`/`get_task` regardless of who dispatched them. Decide whether that's intended
  (a shared team workspace) or needs scoping before changing anything else here.

## Conventions worth keeping

- **Provider registry pattern** (`registerTts`/`registerStt` in `src/speech/registry.ts`): one file
  per provider, registers itself on import, throws in its factory if a required API key is missing.
  Follow this for any new STT/TTS/worker backend.
- **Report marker**: worker prompts end with `REPORT_INSTRUCTIONS` (`src/tasks/report.ts`) asking for
  a `VOICE SUMMARY:` section; `parseReport` falls back to the first sentence if a worker doesn't
  comply, so a new worker type doesn't strictly need to honor the marker, but reports read much
  better if its prompt includes `REPORT_INSTRUCTIONS` too.
- **Task ids** (`t1`, `t2`, ...) are deliberately short so they're easy to say and hear back in a
  voice conversation — keep that if you add task-like ids elsewhere (e.g. Discord thread references).
