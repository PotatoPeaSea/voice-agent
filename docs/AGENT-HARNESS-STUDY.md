# What Hermes Agent and OpenClaw do, and what to copy

Written 2026-10-18. Sources: Hermes's own repo on this machine (`%LOCALAPPDATA%\hermes\hermes-agent`: `AGENTS.md`,
`docs/micro-compaction.md`) and OpenClaw's docs
([gateway architecture](https://docs.openclaw.ai/concepts/architecture), [agent loop](https://docs.openclaw.ai/concepts/agent-loop),
[memory](https://docs.openclaw.ai/concepts/memory), [skills](https://docs.openclaw.ai/tools/skills),
[compaction](https://docs.openclaw.ai/concepts/compaction), [sub-agents](https://docs.openclaw.ai/tools/subagents),
[heartbeat](https://docs.openclaw.ai/gateway/heartbeat)). I read the docs, not OpenClaw's source, so anything below about
OpenClaw is as documented; Hermes details are from its own contributor guide.

## The shape both share

Both are a **small core loop with the capability at the edges**, run by a **long-lived gateway process** that many clients
(CLI, chat apps, desktop app, phone) connect to. The pieces that make them feel like "an assistant that lives on your
machine" rather than a chatbot:

| Idea | Hermes | OpenClaw | Voice Agent today |
|---|---|---|---|
| One daemon, many front ends | gateway for ~20 chat platforms + CLI + TUI + Electron app; same `AIAgent` core everywhere | one Gateway process owns all channels; operator clients and "nodes" (phone, Mac, headless) connect over one typed WebSocket protocol | one Node process that is also the Discord bot; no client protocol |
| Skills = markdown instruction files | `SKILL.md` + frontmatter; loaded on demand; agent can author and patch its own; a "curator" archives stale ones | `SKILL.md`; compact catalog in the prompt (name, description, location), full body read on demand with `skills_read`; gating by OS/binaries/env; agent-authored "workshop" skills with undo | none; behaviour lives in code and in `prompt.ts` |
| Identity/memory as plain files | `SOUL.md`, `memories/`, pluggable `MemoryProvider` | `USER.md` + `MEMORY.md` injected each session, `memory/YYYY-MM-DD.md` daily notes searched on demand (vector + keyword), silent memory flush before compaction, "dreaming" to promote recalled facts | shared memory service (`memory_search` / `memory_remember`), nothing injected automatically |
| Proactive work | `cron` jobs (durations, "every monday 9am", cron expr), `script` pre-step, `context_from` chaining, 3-minute hard interrupt, missed-run catch-up | **heartbeat**: every 30 min the agent gets a prompt and a scratch checklist, replies `NO_REPLY` if nothing needs attention (suppressed, no message); active hours, cheap model, isolated session; plus cron | reminders in memory only (lost on restart, 24 h cap) |
| Sub-agents | `delegate_task`: leaf/orchestrator roles, parallel batch (cap 3), depth cap 2, background mode re-enters the conversation through a completion queue | `sessions_spawn`: own session, optional context fork, cheaper model, results "announced" back to the parent, depth/spawn limits | `dispatch_task` to Claude Code/Hermes; `quick_agent` for lookups |
| Code as a tool | `execute_code` (programmatic tool calling) kept even for leaf workers | n/a found | `run_script` in `quick_agent` (new) |
| Context management | compaction; optional **micro-compaction** (fold the oldest exchange into a running summary every turn); prompt cache treated as sacred | auto-compaction near the limit or on overflow; summarizer budget split newest/older-user/oldest; tool calls stay paired with results; **session pruning** trims old tool results in memory only; silent memory flush first | last 40 messages, then drop; no summary |
| Run safety | iteration budget, interrupt flag, one grace call, error classifier, empty-response guard | per-session run lane (runs serialize), writer-claim so a superseded run can't commit, idle/attempt timeouts, stuck-session diagnostics | per-session promise chain; barge-in aborts |
| Extension discipline | "Footprint ladder": extend code → CLI + skill → service-gated tool → plugin → MCP server → new core tool (last resort) | plugins with typed hooks (`before_tool_call` can block, `before_prompt_build` can narrow tools) | everything is core code |

## Things worth stealing, in order of value for this project

### 1. A stable prompt and tool list per conversation (cheap, matters now)
Hermes's number-one rule: **never change past context, the tool list or the system prompt mid-conversation**, because the
provider's prefix cache (DeepSeek has one too) is what keeps per-turn cost and latency down. We break it in two places:
`find_tools` adds tools mid-conversation, and `/prompt` swaps the system prompt (rare, acceptable). Hermes's answer for
the long tail is not to grow the tool list at all: scripts and MCP servers behind one stable surface.
- Change `find_tools` so the list never changes: `find_tools(query)` returns the matches **with their schemas as the
  result**, and a fixed `call_tool(name, args)` runs one. The prompt prefix stays byte-identical.
- Keep volatile text (time, user names) out of the system prompt; put it in a late message.
- Verify before and after with DeepSeek's cache-hit counters in the usage field.

### 2. Skills (biggest capability win, small code)
A `skills/` folder of `SKILL.md` files with `name` + `description` frontmatter. The prompt carries only a compact
catalog (about 100 characters per skill); a `read_skill(name)` tool loads the body on demand, and `$name` in what you say
forces it. This moves long, situational instructions (the agent-dispatch model/effort table, grill-me, "how I like my
to-do list formatted") out of the prompt that is sent every turn, and it lets us add behaviours by writing markdown. Later:
let the model write and patch its own skills (with an undo log), and a curator that archives unused ones; Hermes keeps usage
counters per skill and never deletes, only archives.
Our `prompt.ts` already has the material: `AGENT_RULES` (roughly 700 tokens, sent on every turn) is a natural first skill.

### 3. Proactivity: persistent reminders, cron and a heartbeat
Reminders today vanish on restart. Replace them with a small job store (`data/jobs.json` or SQLite): one-shot and
recurring jobs, catch-up for missed runs, a hard time limit per run, and a delivery target (speak in voice, post in Discord,
push to phone). On top of that, OpenClaw's heartbeat: every N minutes (active hours only) run the model with a short
checklist file and a cheap model in a fresh session; `NO_REPLY` means stay silent. This is what turns "answers when
spoken to" into "tells you the build failed". The voice-specific part is deciding when it may interrupt: queue it until the
conversation is idle, which `notify()` already does.

### 4. Context compaction instead of dropping messages
Replace `trimHistory(40)` with: summarize the oldest chunk into a running summary message (cheap model), keep tool call and
result pairs together, and **before** dropping anything run a silent "save what matters" turn that writes to memory
(OpenClaw's memory flush). Also prune old tool results first (in memory only): they are most of the tokens, and long voice
sessions with web search and file reads hit this quickly. Micro-compaction is the same idea in small steps but rewrites the
history every turn, which defeats prefix caching; Hermes leaves it off by default for that reason, so start with batch
compaction.

### 5. A gateway/client split (this is dashboard + phone app, backlog items 6 and 7)
OpenClaw's design answers both items almost directly: a **headless gateway** owns the voice pipeline, tools, agents and
memory and exposes **one typed WebSocket protocol**; the Discord bot, the dashboard, a CLI and a phone are all clients.
Details worth copying:
- First frame must be `connect`; request/response/event frames with ids; side-effecting calls take idempotency keys so
  retries are safe; events aren't replayed, clients refresh after a gap; the schema is the single source of truth
  (OpenClaw generates JSON Schema and Swift models from TypeBox; we can do the same with zod).
- **Nodes**: a phone or other device connects with a role and advertises capabilities (microphone, speaker, camera,
  location). The gateway decides what to ask of it. That is the clean way to add "press a button on my phone and talk".
- Device pairing: each client has a keypair, new devices need approval once, then get a token; loopback may auto-approve,
  LAN/Tailscale never does. Reach it remotely over Tailscale or an SSH tunnel, never an open port.
- One gateway per machine, enforced with a lock file, so two copies can't fight over the Discord session.
Hermes does the same with its `tui_gateway` and Electron desktop app talking to one backend, and notes that capabilities
must be scoped by **session** (what this client can do), not by the backend's environment.

### 6. Hooks around the tool loop
OpenClaw's plugin hooks (`before_tool_call` can block, `after_tool_call`, `before_prompt_build` can narrow tools,
`message_sending` can cancel) are a better home for our scattered safety rules than checks inside each tool: the
confirm-in-a-later-reply rule, the credential-file denylist and "don't act on text from a web page" become hooks over the one
loop in `turn.ts`. Do this only when a second client exists; Hermes's own rule is to refuse extension points without a
concrete consumer.

### 7. Smaller loop-hardening ideas
- A tool-free **finalization pass** when tools ran but the model produced no reply (OpenClaw), and an empty-response guard.
- An **iteration budget** shared with sub-agents plus one grace call at the limit (Hermes) instead of a fixed `MAX_ROUNDS`.
- Per-run lanes with a writer claim, so a superseded or barged-in turn can't commit to the history. We rely on awaiting the
  previous reply; a claim check at commit time would be sturdier.
- A `NO_REPLY` sentinel the voice layer swallows instead of speaking.
- Run a `kanban`-style durable task board for multi-step agent work (SQLite, dispatcher loop, auto-block after repeated
  failures). Our task registry already persists; a board matters only once several agents work in parallel.

## What not to copy
- Their breadth (20+ chat platforms, 28 toolsets, billing, update pipeline). We are a voice front end, not a general
  agent platform; Hermes already exists and is reachable as a worker.
- Python-style core surface growth. Both projects reject new core tools; we should keep adding capability as MCP
  servers, skills and scripts, which is what the last round of work did.
- Micro-compaction by default, plugin systems without a second consumer, and an always-on 30-minute heartbeat on a paid
  model (use the cheap model, active hours, and a skip when the checklist is empty).

## Suggested order
1. Skills (small, immediate prompt savings, unlocks the rest). 2. Cache-stable `find_tools`/`call_tool`.
3. Persistent jobs + heartbeat. 4. Compaction with memory flush. 5. Gateway protocol, then dashboard and phone client on it.
