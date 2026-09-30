# Voice Agent

Talk to a Discord bot in a voice channel. A fast conversational LLM turns what you say into
task briefs for Hermes Agent workers and speaks their results back to you.

Full design: see the plan (architecture, latency budget, milestones). Backlog: [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md).

## Status
- [x] Project skeleton, pluggable STT/TTS interfaces, voice profiles (`config/voices.yaml`)
- [x] **Milestone 0: live voice receive/playback under DAVE E2EE** — `npm run spike` (verified 2026-09-24)
- [ ] **Milestone 1: voice conversation** (STT → LLM → TTS with barge-in) — built, awaiting API keys + live test
- [x] **Claude Code agents over ACP**: dispatch, follow-ups, model/effort/mode/fast settings, permission requests by voice, cancel, spoken reports — verified end to end with `npm run chat`
- [x] **Lookups without an agent**: direct file/git/web (MCP) tools, a background `quick_agent`, slow lookups reported as automatic updates — verified live against DeepSeek + Exa
- [ ] Hermes worker · Discord text reports · hardening + Linux (see docs/IMPROVEMENTS.md)

## Setup
Requires Node 22+ and ffmpeg on PATH.

1. `npm install`
2. Create a bot at https://discord.com/developers/applications
   - **Bot** tab: reset/copy the token. No privileged intents are needed.
   - **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; permissions **View Channels, Connect, Speak, Send Messages, Create Public Threads**. Open the URL and add the bot to your server.
3. Run `npm run channels` after setting `DISCORD_TOKEN` to print your server and voice channel IDs (or enable Developer Mode in Discord and copy them). Your own user ID still needs Developer Mode → right-click yourself → Copy User ID.
4. `cp .env.example .env` and fill in `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_VOICE_CHANNEL_ID`, `ALLOWED_USER_IDS`.
5. `npm run deps:report` — all of Opus, encryption, DAVE (`@snazzah/davey`) and FFmpeg should be found.

## Milestone 0 spike
```
npm run spike
```
Join the voice channel and talk. Each utterance is saved to `recordings/*.wav` and echoed back.
The log shows packets received and how long after you stop talking the echo starts.
Set `VERBOSE=1` in `.env` to see voice/DAVE debug output if receive fails.

**Pass:** you hear yourself echoed and the WAV files sound clean.
**Fail modes:** no `speaking start` lines (receive/DAVE broken), garbled WAVs (decrypt/decode issue),
no echo (send path). If receive fails, see the fallbacks in the plan.

## Milestone 1: talk to it
1. Add keys to `.env`: `LLM_API_KEY` (DeepSeek), `DEEPGRAM_API_KEY`, and `CARTESIA_API_KEY` and/or `ELEVENLABS_API_KEY`.
2. Pick a voice: `npm run voices -- cartesia` (or `elevenlabs`), paste an ID into `config/voices.yaml`, and set `active`.
3. `npm run check` verifies every key, model and voice and prints latency; TTS samples land in `recordings/`.
4. `npm start`, join the voice channel and talk. Talk over it to interrupt.

Each reply logs a latency breakdown: speech end → turn end → LLM first token → first sentence → TTS first audio → playing.

## Qwen3-TTS voice (local GPU + cloud fallback)
The active voice is `qwen` in `config/voices.yaml`: Qwen3-TTS on your GPU, falling back to
Qwen3-TTS on Alibaba Cloud (`qwen-cloud`) if the local service is down or too slow.

- Local service: Python 3.12 + [uv](https://docs.astral.sh/uv/) + an NVIDIA GPU. First run downloads the model (~2 GB for 0.6B).
  ```
  start-tts.cmd      # (./start-tts.sh on Linux) restarts services/qwen-tts on http://127.0.0.1:8765, logs to qwen-tts.log
  npm run tts        # same, without stopping an old instance or writing the log file
  ```
  Use `QWEN_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` for higher quality and `instruct` (tone) support.
- Cloud fallback: set `DASHSCOPE_API_KEY` (Alibaba Cloud Model Studio, international region by default).
- Preset speakers: `npm run voices -- qwen-local`. English natives are Aiden and Ryan; others speak English with an accent.

### Cloned voices and `/voice`
- `npm run clone-voice -- <name> <clips or folder>` converts voice clips (mp4/m4a/mp3/wav/...), transcribes them with
  Deepgram and saves the longest clean stretch (≤15s) as `services/qwen-tts/voices/<name>.wav` + `.txt`. The service
  speaks it with the Qwen3-TTS **Base** model (loaded next to CustomVoice, ~2 GB more VRAM; `QWEN_TTS_CLONE_MODEL=off`
  disables it) and picks up new voices without a restart. Then add a `qwen-local` profile with `voiceId: <name>`.
- `/voice` in Discord lists the profiles; `/voice name:<profile>` switches live, says a line in the new voice and saves
  the choice as `active` in `config/voices.yaml`.
- Cloned voices run ~1.3x realtime on an RTX 3060 (presets ~1.7x), because the reference clip is in every prompt.

### System prompts and `/prompt`
- Two personas in `src/orchestrator/prompt.ts`: `default` (terse assistant) and `chatty` (relaxed, talkative; same agent rules).
- `/prompt` lists them; `/prompt name:<prompt>` switches for everyone from the next reply. Saying "be chattier" /
  "back to normal" works too (the `switch_system_prompt` tool). It resets to `default` on restart.

## Looking things up without an agent
Questions that only need reading don't go to an agent. The voice model has three tiers, picked per request:

1. **Direct lookups**, answered within the turn with no read-back: `list_files`, `read_file`, `search_files`,
   `git_info` and `current_time` over the `WORKER_ROOTS` folders, plus tools from MCP servers (web search out of
   the box). "What's the weather in Tokyo?", "What was the last commit in the voice agent project?"
2. **`quick_agent`**, for questions that need several lookups: a short tool loop with the same LLM and the same
   read-only tools, run inside the bot. "Research Proxmox vs TrueNAS for a home server." It always runs in the
   background: the bot says it'll get back to you and speaks the answer when it's ready (typically 5-20 s).
3. **`dispatch_task`** (below), only for work that changes things or runs long.

A lookup still running after `TOOL_WAIT_SECONDS` (default 3) carries on in the background the same way, and hold
music can play while you wait. File lookups can't leave `WORKER_ROOTS` (symlinks included) and won't open
credential files (`.env`, keys, `auth.json`...), because file contents are sent to the LLM provider.

### MCP servers
`config/mcp.yaml` lists MCP servers whose tools the voice model calls directly, as `<server>__<tool>`. It ships with
Exa's free, keyless web search (`web_search_exa`, `web_fetch_exa`). Add local servers (`command`) or remote ones
(`url`), and list only the tools you want: every tool costs prompt space on every turn, and these run without the
agents' permission prompts. Tools a server doesn't mark read-only are described to the model as "Takes action:
confirm with the user first". `${VAR}` in the file is filled from `.env`. The startup log shows each server's tools.

## Claude Code agents (ACP)
The voice model can hand work to Claude Code through the [Agent Client Protocol](https://agentclientprotocol.com)
(`@agentclientprotocol/claude-agent-acp`). It uses your existing Claude Code login.

Say things like:
- "Have Claude fix the failing tests in the voice agent project, use Opus on high effort."
- "How's task t2 going?" / "What did it change?"
- "Switch t2 to plan mode." / "Put it on Sonnet, low effort." / "Turn fast mode on."
- "Tell it to also update the README." / "Send it /compact."
- "Cancel that."

When an agent asks permission to run a command, the bot tells you what it wants and waits for your answer.
Set `CLAUDE_MODE=auto` in `.env` to let Claude decide routine permissions itself.
Agents may only work inside `WORKER_ROOTS` (default: the folder containing this project).

Useful commands:
- `npm run chat` — same brain and agents, by keyboard. Scripted: `npm run chat -- "message" "next message"`.
- `npm run agent:probe` — show the models, effort levels and modes Claude Code offers.
- `npm run agent:smoke` — run a tiny read-only task end to end.

Task logs and reports are written to `data/tasks/`.

### Hold music while agents work
Put audio files (mp3, wav, ogg, flac, m4a...) in `music/` (or point `MUSIC_PATH` at a file or folder). After a task
is dispatched (or a lookup goes to the background) and the call has been quiet for `MUSIC_DELAY_SECONDS` (default 5), the bot plays them shuffled at
`MUSIC_VOLUME` (default 0.2). The music stops the moment anyone speaks, a task reports back or asks permission, or no
task is running any more, and never plays over the bot's own speech. `MUSIC_ENABLED=false` turns it off; without
files or ffmpeg there's simply no music.

### Playing songs on request
The same `music/` folder is the song list for three model tools: `list_songs` (list or search by name),
`play_music` (e.g. "play Moonlight"; partial or misheard names are fuzzy-matched, no name picks one at random) and
`stop_music`. A requested song starts once the bot finishes its reply, plays at `MUSIC_SONG_VOLUME` (default 0.5),
pauses whenever the bot speaks and resumes where it was, and ends with the track, `stop_music` or leaving the call.
Hold music doesn't play while a song is requested. Song titles are the file names, so name files the way you'd say
them (`moonlight.mp3`, `river_flows_in_you.mp3`).

The tracks in `music/` (`grateful.mp3`, `moonlight.mp3`) were copied from the user's NAS, Potato Server, at the
SMB share `\\<nas-host>\nas\music`, which holds the full music library and is the source for hold-music tracks.
