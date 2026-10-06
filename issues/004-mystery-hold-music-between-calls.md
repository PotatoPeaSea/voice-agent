# 004 - Mystery hold music between calls

## Symptom
Music starts playing on its own between calls, and the user cannot get it to stop by asking the voice assistant to skip or stop the song.

## What was observed
- The user heard a song playing and asked the assistant to skip it.
- The assistant's stop_music tool reported that no music was playing, so the assistant could not stop it.
- The user believes it is hold music played by the call system between calls, not by the voice agent.
- It is unclear whether this is the voice agent's own music playback or an external call/telephony system's hold music.

## Resolution
Resolved (the "unconfirmed" above is now confirmed). It was the voice agent's own hold music, not a call system: `src/bot/hold-music.ts` starts music by itself once an agent has been working and the call has been quiet for `MUSIC_DELAY_SECONDS` (the log shows `hold music: playing while agents work`). `stop_music` only knew about songs requested with `play_music`, so it truthfully said none was playing.
- `stop_music` now also stops hold music, and keeps it off until the agents that were working have finished (the next task gets hold music again).
- `MUSIC_ENABLED=false` still turns hold music off completely.
