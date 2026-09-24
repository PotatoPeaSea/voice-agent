# Voice Agent

Talk to a Discord bot in a voice channel. A fast conversational LLM turns what you say into
task briefs for Hermes Agent workers and speaks their results back to you.

Full design: see the plan (architecture, latency budget, milestones). Backlog: [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md).

## Status
- [x] Project skeleton, pluggable STT/TTS interfaces, voice profiles (`config/voices.yaml`)
- [x] **Milestone 0: live voice receive/playback under DAVE E2EE** — `npm run spike` (verified 2026-09-24)
- [ ] M1 voice loop · M2 Hermes adapter · M3 orchestrator tools · M4 questions/cancel · M5 hardening + Linux

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
