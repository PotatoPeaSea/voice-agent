# Improvements backlog

Ordered by priority. Pick from the top. [AGENT-HARNESS-STUDY.md](AGENT-HARNESS-STUDY.md) compares us with Hermes Agent and OpenClaw and proposes
items 8-11 below. Items 6 and 7 are larger product directions; sequence them with the user.

## 1. Sandboxed code-mode tool calling (first version done, in `quick_agent`)
Done: `quick_agent` has a `run_script` tool (`src/orchestrator/code-mode.ts`). The model writes the body of an async
JavaScript function that calls the read-only lookups (`await tools.name({...})`, `Promise.all`, loops) and gets back only
the script's return value. It runs in a QuickJS WebAssembly VM (`src/sandbox/script.ts`, `quickjs-emscripten`): no
filesystem, network, process, timers or imports, a 32 MB memory cap, a 60 s time limit (guest loops are interrupted),
25 tool calls per script and output cut to 6000 characters. Tools marked "Takes action" are not callable from scripts.
`CODE_MODE_ENABLED=false` turns it off.
Still to do:
- Not yet verified live against a real model: check that DeepSeek writes working scripts and that it picks `run_script`
  only for 3+ lookups. Tune the prompt in `quick-agent.ts` / the tool description from real transcripts.
- Offer it to the front model too, once it is proven in `quick_agent`.
- Let scripts use the deferred tools of item 2 without their schemas in the prompt (done for `core: false` servers via the
  catalog; check it with a real server).

## 2. Many more tools for the front model, without bloating every turn (first version done)
Done:
- Tool search: a `core: false` flag per MCP server in `config/mcp.yaml` keeps its tools out of the voice model's prompt.
  `find_tools(query)` (`src/orchestrator/find-tools.ts`) matches the held-back tools, switches them on for the next calls
  (at most 12 active, oldest drop out) and is itself offered only while something is held back. The Google server is
  `core: false` now.
- `quick_agent` and `run_script` always get the whole catalog, so "do something with my calendar" costs the front model
  one call.
Still to do:
- Add more servers to `config/mcp.yaml` (no code): the commented-out time server, Home Assistant, Spotify, GitHub,
  a notes server, Playwright. Try with `tools: "*"` and `core: false`, then trim to what is used.
- Native `ToolSet`s for more bot-only abilities (`music-tools.ts` is the smallest template): move users between
  channels, switch voice/TTS mid-call.
- Search is plain keyword matching on names and descriptions; if it misses, add synonyms or an embedding lookup.
- MCP tools bypass the agents' permission prompts; the only guard on action tools is the "confirm with the user
  first" description. Keep high-impact actions (sending email, deleting files) behind an agent or an explicit
  confirmation step.

## 3. Local STT on the Linux workstation
Self-host a streaming STT with turn detection, registered as a provider, with Deepgram as fallback.

## 4. Speech-to-speech front end (optional)
Evaluate a realtime speech-to-speech model as an alternative front desk for lower latency,
keeping the same tool set.

## 5. Multi-user support
Per-user conversation state, allowlists and project roots.

## 6. A dashboard to run and manage it, ideally a desktop app
Today everything is started and managed from the command line with `npm run ...` (`start`, `tts`, `check`, `voices`,
`clone-voice`, `google:auth`, ...), plus the TTS service, `.env` and the YAML files edited by hand. That is not friendly.
Build a proper dashboard, preferably a desktop application (Electron or Tauri):
- Start, stop and restart the bot and the TTS service, with live logs and status (connected, which voice, GPU/CPU, MCP
  servers up or failed, running agent tasks and background jobs).
- Edit settings in a form instead of `.env` / `config/*.yaml` (keys stay in the OS credential store or a protected file);
  manage voices (listing, cloning, picking the default), MCP servers and their tools (including `core`), prompts, and
  the allowed users and folders.
- Walk through one-time setup: Discord bot token and channel, API keys, Google authorization, a first test call.
- Show tasks, reports, reminders and shared memory, and let you cancel or answer an agent's permission request.
- The bot should run as a background service the dashboard talks to (local HTTP/WebSocket API), so closing the window
  does not hang up the call.

## 7. More than Discord: a phone app you tap to start talking, like Siri but better
Discord should be one front end, not the only one. Move the voice pipeline behind a transport interface (audio in,
audio out, a way to be notified) so other clients can use the same orchestrator, tools, agents and memory:
- A mobile app (iOS and Android; or a PWA first) with a big button: press and start talking, no Discord and no
  joining a channel. Streams the microphone to the bot over WebRTC or a WebSocket and plays the reply, with barge-in.
- It has to work away from the home network (Tailscale, or a small authenticated relay), and wake from a lock-screen
  widget, a shortcut or the side button the way Siri does.
- "Better than Siri": the same assistant as the Discord one (your tools, memory, coding agents, reminders), a persistent
  conversation across devices, and push notifications for finished agent tasks and reminders.
- Other transports follow the same shape: a desktop push-to-talk hotkey, a phone call (SIP), a smart speaker.
- Needs per-user state first (item 5), since a phone client and a Discord client are two sessions of one person.

## 8. Skills: markdown instruction files loaded on demand
`skills/<name>/SKILL.md` with name + description frontmatter; a compact catalog in the prompt, a `read_skill` tool for the body.
Move `AGENT_RULES` and grill-me out of the every-turn prompt first. Later: model-authored skills with undo. (Study, section 2.)

## 9. Cache-stable tool search
`find_tools` currently adds tools mid-conversation, which changes the prompt prefix and defeats the provider's cache. Return the
matched schemas as the result and add a fixed `call_tool(name, args)` instead. (Study, section 1.)

## 10. Persistent jobs, cron and a heartbeat
Replace in-memory reminders with a job store (recurring, catch-up, time limit, delivery target), then a cheap-model heartbeat with
`NO_REPLY` suppression and active hours. (Study, section 3.)

## 11. Context compaction with a memory flush
Replace `trimHistory(40)` with a running summary, prune old tool results first, and save what matters to memory before dropping
anything. (Study, section 4.) Item 5's gateway protocol is described in the study, section 5, and is the base for items 6 and 7.

## Done
- Hermes Agent worker adapter (`src/workers/hermes-acp.ts`), chosen per task via `dispatch_task`'s `worker`.
- Task reports in Discord text: a thread per task with live progress and the full report.
- Tasks persisted across restarts (`data/tasks/registry.json`), reattached with ACP `session/resume`.
- Lookups without an agent: direct file/git/time tools, MCP servers (`config/mcp.yaml`, Exa web search by
  default), `quick_agent`, and slow lookups finishing in the background as automatic updates.
