# 003 - Music stops when assistant goes quiet

## Symptom
When the assistant goes quiet (stops listening after the user says they're done), any music that is currently playing stops.

## What was observed
- Triggered by the assistant going quiet (e.g. the user telling it they're done, putting it to sleep).
- Music playback halts along with the assistant going quiet, rather than continuing in the background.
- User wants music to keep playing while the assistant is asleep, and only stop when the user wakes the assistant again (e.g. by saying the wake word).

## Status
Resolved in 159b6c0: requested songs no longer stay paused after the bot goes quiet; speech and mic activity it ignores while asleep don't hold them back (they stop only on stop_music, track end, a new song or leaving voice).
