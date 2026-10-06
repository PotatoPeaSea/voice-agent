# Shared memory (voice agent, Claude agents, Hermes)

One memory service on potatoserver that every agent writes to and reads from, so something said to the voice
agent can be recalled by a Claude Code agent and the other way round.

The service is **memory-core** from [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
(an HTTP gateway over SQLite, port 8420). We run only that one piece, not its proxy or admin panel. The proxy
re-routes every agent's LLM traffic through itself, swaps in its own API key (so a Claude subscription wouldn't work),
pops a team/agent picker that headless agents can't answer, and tells the model to search with `curl` through Bash.
Talking to the gateway directly avoids all of that.

## What each agent gets

| Agent | How it connects | What it adds to the context |
|---|---|---|
| Voice agent | `MEMORY_URL` in `.env`: saves every completed exchange, and gets `memory_search` + `memory_remember` | Two tool definitions (~300 tokens, every turn). Search results only when it searches: at most 5 hits of 400 characters |
| Claude Code (incl. agents the voice agent dispatches) | `scripts/claude-memory-hook.mjs` as a `UserPromptSubmit` and a `Stop` hook | At most 3 memories of 300 characters (~250 tokens), only when something matches; nothing otherwise |
| Hermes on potatoserver | Not wired. It ships a native `memory_tencentdb` provider plugin that talks to this same gateway | Its own recall budget; see the plugin's README |

Everything uses the same team/user/agent ids (`default` / `default` / `shared`, `MEMORY_AGENT_ID`), which is what
makes the memory shared. Without an LLM key the service stores and searches **raw conversation** only. Turning on
fact extraction (below) adds distilled facts, which make for better recall.

## Deploy (potatoserver)

```
bash scripts/deploy-memory-potatoserver.sh
```

It builds the image from the reviewed source commit (no Docker Hub image), writes a config and a chmod-600 key file
under `~/tdai-memory`, runs the container with `--restart unless-stopped` published only on potatoserver's Tailscale
address, smoke-tests write and search from this PC, and adds `MEMORY_URL` / `MEMORY_API_KEY` to `.env`. It prints
each step and can be re-run. Restart the voice agent afterwards.

## Claude Code hooks

Add to `~/.claude/settings.json` (merge with your existing `hooks`; use the absolute path to this project):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node \"C:/Users/smart/Documents/Projects/Voice Agent/scripts/claude-memory-hook.mjs\" recall", "timeout": 5 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"C:/Users/smart/Documents/Projects/Voice Agent/scripts/claude-memory-hook.mjs\" capture", "timeout": 10 }] }
    ]
  }
}
```

The hook reads `MEMORY_URL`, `MEMORY_API_KEY` and `MEMORY_AGENT_ID` from the environment or this project's `.env`, does
nothing if they're missing, and never blocks a prompt: it gives up after 2.5 seconds. Agents the voice agent
dispatches load your user settings too (the ACP adapter uses `settingSources: user, project, local`), so the same hooks
apply to them. That part is read from the adapter's code, not yet observed.

## Turning on fact extraction (optional, costs tokens on a separate LLM)

The service can turn conversation into distilled facts (L1), scene summaries (L2) and a persona (L3). That runs on its
own LLM: roughly every 5 conversation turns for facts, at most every 15 minutes for scenes, every 50 new facts for the
persona. Estimate a few hundred thousand tokens a day at heavy use on a cheap model (not measured). To enable: put a
real key in `~/tdai-memory/gateway.env` as `TDAI_LLM_API_KEY`, set `memory.extraction.enabled: true` in
`~/tdai-memory/config/tdai-gateway.yaml` (and `llm.baseUrl` / `llm.model` if not DeepSeek), then re-run the deploy script.

## Notes and limits

- Conversation text, including anything said in voice, is stored in the docker volume on potatoserver. Nothing leaves
  your network unless extraction is on, in which case it goes to that LLM provider.
- Search is keyword (BM25) only: no embeddings are configured, so "my pet" won't find "my cat".
- The client and hook were tested against a stand-in server that speaks the documented v3 API, not yet against the real
  service. The deploy script's smoke test is the first real check.
- Remove everything: `ssh potatoserver 'docker rm -f tdai-memory-core; docker volume rm tdai-memory-core-data; rm -rf ~/tdai-memory'`.
