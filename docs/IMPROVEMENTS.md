# Improvements backlog

Ordered by priority. Pick from the top.

## 1. Sandboxed code-mode tool calling (next)
Today every lookup costs one LLM round trip per step: the front model (or `quick_agent`) calls a tool, waits,
reads the result, calls the next. With code mode the model instead writes one short script that calls several
tools (loops, filters, joins results) and only the script's final output comes back, cutting round trips and
keeping bulky intermediate results (search pages, file contents) out of the context.
- Run the script in a real sandbox: no filesystem, network or process access except through the tool functions
  it's handed (the lookup tools in `src/orchestrator/lookup-tools.ts` and the MCP tools in `src/lookup/mcp.ts`).
  Candidates: a V8 isolate (`isolated-vm`), a QuickJS/WASM runtime, or Deno with all permissions denied.
  Plain `node:vm` is not a sandbox.
- CPU/memory/time limits and a cap on tool calls per script; the script's output goes through the same
  truncation as tool results.
- Expose it as a mode of `quick_agent` first (it already runs in the background), then consider it for the
  front model.
- Only read-only tools inside the sandbox; anything marked "Takes action" stays a direct, confirmed tool call.

## 2. Many more tools for the front model, without bloating every turn
Give the voice model far more capabilities while keeping it sharp. Small models pick worse from long lists, and
every tool's description is sent on every turn (latency), so growth needs a scaling strategy, not just more entries.
- More MCP servers in `config/mcp.yaml` (no code): the commented-out time server, Home Assistant, Spotify, GitHub,
  Google Calendar/Gmail, a memory/notes server, Playwright. Try with `tools: "*"`, then trim to what's used.
- Native `ToolSet`s (`src/orchestrator/toolset.ts`, combined in `src/orchestrator/toolbox.ts`) for bot-only
  abilities: post to a Discord text channel, move users between channels, reminders that speak up later,
  switching voice/TTS mid-call. `music-tools.ts` is the smallest template.
- Tool search: a small always-on core set, everything else in a catalog behind one `find_tools(query)` tool that
  activates matches for the rest of the session. E.g. a per-server `core: false` flag in `mcp.yaml` to defer a
  whole server.
- Push the long tail down a tier: `quick_agent` gets the full catalog, the front model only the core set and hands
  off ("do something with my calendar") in one call; the quick agent already runs in the background.
- Code mode (item 1) composes with this: scripts can call deferred tools without their schemas in the prompt.
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

## Done
- Hermes Agent worker adapter (`src/workers/hermes-acp.ts`), chosen per task via `dispatch_task`'s `worker`.
- Task reports in Discord text: a thread per task with live progress and the full report.
- Tasks persisted across restarts (`data/tasks/registry.json`), reattached with ACP `session/resume`.
- Lookups without an agent: direct file/git/time tools, MCP servers (`config/mcp.yaml`, Exa web search by
  default), `quick_agent`, and slow lookups finishing in the background as automatic updates.
