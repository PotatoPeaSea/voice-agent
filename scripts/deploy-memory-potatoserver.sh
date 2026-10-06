#!/usr/bin/env bash
# Deploys the shared memory service (TencentDB-Agent-Memory's memory-core) on potatoserver, then points this
# project's .env at it. Run it yourself from Git Bash in the project folder:
#
#     bash scripts/deploy-memory-potatoserver.sh
#
# What it does (each step prints what it is doing; safe to re-run):
#   1. Checks ssh to potatoserver and that docker works there.
#   2. Uses the source clone in ~/tdai-memory/src-repo, pinned to the commit that was reviewed
#      (it clones it if missing). It builds the image FROM THAT SOURCE; it does not pull an image from Docker Hub.
#   3. Writes ~/tdai-memory/config/tdai-gateway.yaml (English search, extraction OFF) and ~/tdai-memory/gateway.env
#      (chmod 600, holds the API key).
#   4. Runs the container "tdai-memory-core" with --restart unless-stopped, published ONLY on potatoserver's
#      Tailscale address, port 8420, behind the API key. Data lives in the docker volume tdai-memory-core-data.
#   5. Smoke-tests it from this PC, then adds MEMORY_URL / MEMORY_API_KEY to .env.
#
# To remove it later:  ssh potatoserver 'docker rm -f tdai-memory-core; docker volume rm tdai-memory-core-data; rm -rf ~/tdai-memory'
set -euo pipefail

HOST="${HOST:-potatoserver}"
PORT=8420
PINNED_COMMIT="8b86874"
REPO_URL="https://github.com/TencentCloud/TencentDB-Agent-Memory"
ENV_FILE="${ENV_FILE:-.env}"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
remote() { ssh -o BatchMode=yes "$HOST" "$@"; }

say "1/5 Checking ssh and docker on $HOST"
remote 'docker version --format "docker {{.Server.Version}}"' || die "can't reach $HOST or docker isn't usable there"
TS_IP="$(remote 'tailscale ip -4 | head -1')"
[ -n "$TS_IP" ] || die "no Tailscale address on $HOST; the service is only published on Tailscale"
echo "Tailscale address: $TS_IP"

say "2/5 Source at commit $PINNED_COMMIT"
remote "mkdir -p ~/tdai-memory && cd ~/tdai-memory && { [ -d src-repo/.git ] || git clone -q $REPO_URL src-repo; }"
HEAD_NOW="$(remote 'git -C ~/tdai-memory/src-repo rev-parse --short=7 HEAD')"
if [ "$HEAD_NOW" != "$PINNED_COMMIT" ]; then
  echo "Clone is at $HEAD_NOW, not the reviewed $PINNED_COMMIT; checking out the reviewed commit."
  remote "cd ~/tdai-memory/src-repo && git fetch -q origin $PINNED_COMMIT 2>/dev/null || git fetch -q --unshallow; git checkout -q $PINNED_COMMIT" \
    || die "couldn't check out $PINNED_COMMIT. Not building unreviewed code."
fi

say "3/5 Config and API key"
# Reuse the key from .env if there is one, so re-running doesn't break clients.
KEY="$(grep -E '^MEMORY_API_KEY=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
[ -n "$KEY" ] || KEY="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"
printf 'TDAI_GATEWAY_API_KEY=%s\nTDAI_LLM_API_KEY=unused\n' "$KEY" | remote 'umask 077; mkdir -p ~/tdai-memory; cat > ~/tdai-memory/gateway.env; chmod 600 ~/tdai-memory/gateway.env'
remote 'mkdir -p ~/tdai-memory/config && cat > ~/tdai-memory/config/tdai-gateway.yaml' <<'YAML'
# Shared memory for the voice agent, Claude agents and Hermes.
deployMode: standalone
stateBackend: "local"

server:
  port: 8420
  host: "0.0.0.0"          # inside the container; docker publishes it on the Tailscale address only

data:
  baseDir: "/data/tdai-memory"

# LLM used only to turn raw conversation into facts, scenes and a persona (L1-L3). Storing and searching raw
# conversation (L0) doesn't need it. To turn it on: put a real key in gateway.env as TDAI_LLM_API_KEY, set
# memory.extraction.enabled to true, and re-run this script.
llm:
  baseUrl: "https://api.deepseek.com/v1"
  apiKey: "${TDAI_LLM_API_KEY}"
  model: "deepseek-chat"
  maxTokens: 4096
  timeoutMs: 120000

memory:
  capture:
    enabled: true
  extraction:
    enabled: false
    enableDedup: true
    maxMemoriesPerSession: 20
  persona:
    triggerEveryN: 50
    maxScenes: 15
  pipeline:
    everyNConversations: 5
    enableWarmup: true
    l1IdleTimeoutSeconds: 600
    l2DelayAfterL1Seconds: 90
    l2MinIntervalSeconds: 900
    l2MaxIntervalSeconds: 3600
  recall:
    enabled: true
    maxResults: 5
    scoreThreshold: 0.3
    strategy: "hybrid"
    timeoutMs: 5000
  storeBackend: "sqlite"
  embedding:
    provider: "none"
  bm25:
    enabled: true
    language: "en"
YAML

say "4/5 Building the image from source and starting the container (the build takes a few minutes)"
remote 'cd ~/tdai-memory/src-repo/MemoryCore && DOCKER_BUILDKIT=1 docker build -q -t tdai-memory-core:local .'
remote "docker rm -f tdai-memory-core >/dev/null 2>&1 || true; docker run -d --name tdai-memory-core --restart unless-stopped \
  --env-file ~/tdai-memory/gateway.env \
  -v tdai-memory-core-data:/data/tdai-memory \
  -v ~/tdai-memory/config/tdai-gateway.yaml:/data/config/tdai-gateway.yaml:ro \
  -p $TS_IP:$PORT:$PORT tdai-memory-core:local"
for i in $(seq 1 30); do
  remote "curl -fsS http://$TS_IP:$PORT/health >/dev/null" 2>/dev/null && break
  [ "$i" = 30 ] && { remote 'docker logs --tail 40 tdai-memory-core' || true; die "the service didn't come up; logs above"; }
  sleep 2
done
echo "service is up on $TS_IP:$PORT"

say "5/5 Smoke test from this PC"
URL="http://$HOST:$PORT"
curl -fsS "$URL/health" >/dev/null || die "this PC can't reach $URL (is Tailscale on?)"
call() { curl -fsS -X POST "$URL$1" -H 'content-type: application/json' -H "authorization: Bearer $KEY" -H 'x-tdai-service-id: default' -d "$2"; }
call /v3/conversation/add '{"team_id":"default","agent_id":"shared","user_id":"default","session_id":"deploy-smoke","messages":[{"role":"user","content":"deploy smoke test: the pineapple password is not a password"}]}' >/dev/null
sleep 1
if call /v3/conversation/search '{"team_id":"default","agent_id":"shared","user_id":"default","query":"pineapple","limit":3}' | grep -q pineapple; then
  echo "write + search round trip works"
else
  die "wrote a message but couldn't search it back; check: ssh $HOST docker logs tdai-memory-core"
fi
if curl -sS -o /dev/null -w '%{http_code}' -X POST "$URL/v3/conversation/search" -H 'content-type: application/json' -d '{"query":"x"}' | grep -qE '^(401|403)$'; then
  echo "requests without the key are refused"
else
  echo "WARNING: a request without the API key wasn't refused; don't leave it like this"
fi

if ! grep -q '^MEMORY_URL=' "$ENV_FILE" 2>/dev/null; then
  printf '\n# Shared memory service on potatoserver (memory-core in Docker, Tailscale only)\nMEMORY_URL=%s\nMEMORY_API_KEY=%s\n' "$URL" "$KEY" >> "$ENV_FILE"
  echo "added MEMORY_URL and MEMORY_API_KEY to $ENV_FILE"
else
  echo "$ENV_FILE already has MEMORY_URL; left it alone"
fi
say "Done. Restart the voice agent to pick it up. Claude Code hooks: see docs/MEMORY.md."
