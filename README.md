# Voice Agent

Talk to a Discord bot in a voice channel. A fast conversational LLM turns what you say into
task briefs for Hermes Agent workers and speaks their results back to you.

Full design: see the plan (architecture, latency budget, milestones). Backlog: [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md).

## Status
- [x] Project skeleton, pluggable STT/TTS interfaces, voice profiles (`config/voices.yaml`)
- [x] **Milestone 0: live voice receive/playback under DAVE E2EE** — `npm run spike` (verified 2026-09-24)
- [ ] **Milestone 1: voice conversation** (STT → LLM → TTS with barge-in) — built, awaiting API keys + live test
- [x] **Claude Code agents over ACP**: dispatch, follow-ups, model/effort/mode/fast settings, permission requests by voice, cancel, spoken reports — verified end to end with `npm run chat`
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
