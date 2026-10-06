# 001 - Long outgoing messages get cut off mid-send

## Symptom
When the assistant sends a long outgoing message, especially when dispatching a task to a coding agent, the message is truncated partway through and the send fails.

## What was observed
- Repeatedly happened while trying to dispatch a task to a coding agent.
- The tool call was rejected several times with a JSON parse error, because the arguments were cut off mid-string.
- The assistant had to retry with progressively shorter text before a send finally succeeded.
- User suspects the message is being truncated at a fixed length, or cut off by a timeout.

## Possible causes / to investigate
- A fixed-length limit (buffer size, max token/char count) on the outgoing message path, applied before the tool call is serialized.
- A timeout on the send/stream path that cuts the message off mid-generation or mid-transmission rather than waiting for completion.
- Whether truncation happens before serialization (the text itself is cut short) or after (the JSON is cut short while still valid text) — these point to different fixes.
- Check where outgoing text is assembled (e.g. message builder / tool-call argument builder) for any hardcoded length caps.
- Check any network/socket/HTTP client config for a response or write timeout on the send path.
- Check whether the dispatch-to-coding-agent path specifically differs from normal chat sends (e.g. larger payload, different serializer) — this may explain why it shows up there and not elsewhere.
- Confirm whether retries with shorter text succeeding is consistent with a length cap (works below some threshold) vs. a timeout (works when generation/send is faster).

## Status
Resolved. Root cause: `max_tokens: 800` in `src/llm/chat.ts` capped every model reply, so a long `dispatch_task` brief was cut off mid-JSON (the log shows three "arguments were not valid JSON" errors in a row, then a shorter retry that fit). It was a length cap, not a timeout; retries worked only because they were shorter.
- The cap is now `LLM_MAX_TOKENS` (default 4096).
- If a reply still hits the cap while writing a tool call, the call isn't run and the broken arguments aren't kept in the history; the model is told it was cut off and to retry shorter. Bad-JSON errors also no longer echo the whole payload back into the context.
