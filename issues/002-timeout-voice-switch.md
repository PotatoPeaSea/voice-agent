# 002 - Assistant's voice switches after dispatching an agent task

## Symptom
Every time the assistant dispatches a task to a coding agent, a timeout triggers and the assistant's voice changes (it "swings voices").

## What was observed
- Happens consistently when a task is dispatched to a coding agent.
- Unclear whether this is caused by resource contention on the machine, or whether dispatching a task inherently introduces a delay that trips a fallback and changes the voice.
- User is unsure whether this is a bug or expected behavior under load — both hypotheses should be recorded and investigated.

## Hypotheses
1. **Resource contention**: Dispatching a coding agent competes for CPU/GPU/memory with the TTS pipeline, causing it to slow down or fail and fall back to a different (likely lighter/default) voice or model.
2. **Inherent timeout in dispatch path**: Dispatching to a coding agent blocks or delays the pipeline long enough that some timeout elsewhere (e.g. in the TTS service, voice-clone model loading, or an orchestrator watchdog) fires and falls back to a default voice, independent of actual system load.

## Possible causes / to investigate
- Locate the TTS path and any fallback/timeout logic that can switch voice or model (e.g. "if primary voice doesn't respond in N seconds, use fallback voice").
- Check whether the dispatch-to-coding-agent call blocks the same thread/process/event loop that the audio pipeline runs on, versus running asynchronously.
- Check GPU/CPU usage during a dispatch to see if the TTS/voice-clone model is being starved of resources at the moment of the switch (ties to [[no-extra-gpu-instances]] constraint of a single 12 GB GPU).
- Check logs/timestamps for the exact moment the voice switches relative to when the dispatch call is made, to see if it's immediate (points to a fixed timeout) or variable (points to load-dependent contention).
- Determine whether the fallback voice is a fixed "default" voice (supports timeout/fallback hypothesis) or appears to be reusing whatever model was last available (supports resource contention hypothesis).
- Check whether this only happens with coding-agent dispatch or also with other long-running / blocking operations, to isolate whether it's specific to the dispatch path or general to any slow operation.

## Status
Resolved. Hypothesis 2 was right: not resource contention. In the log, `tts qwen-local failed (no audio within 5000ms)` lands exactly 5.0s after the reply began. While the model spent ~5s writing the long `dispatch_task` arguments there was no text for the voice to speak, but the 5s first-audio timeout was already running. It tripped, and the fallback voice (the `qwen` Aiden preset) took over for the 60s cool-down, which is the voice swing.
- The first-audio timeout now starts when the voice is handed its first sentence, not when the reply starts (`src/speech/fallback.ts`). A genuinely slow voice still falls back.
- Issue 001's larger token cap and shorter retries also remove most of the long silent generations.
