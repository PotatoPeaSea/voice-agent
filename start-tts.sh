#!/usr/bin/env bash
# Start (or restart) the local Qwen3-TTS service (Linux/macOS).
# Stops whatever is already listening on the port first, then logs to the console and qwen-tts.log.
set -euo pipefail
cd "$(dirname "$0")"
export QWEN_TTS_PORT="${QWEN_TTS_PORT:-8765}"
export QWEN_TTS_LOG="${QWEN_TTS_LOG:-$PWD/qwen-tts.log}"

if pids=$(lsof -ti "tcp:$QWEN_TTS_PORT" -sTCP:LISTEN 2>/dev/null); then
  echo "Stopping the TTS service already on port $QWEN_TTS_PORT (PID $pids)"
  kill $pids
  sleep 2
fi

echo "Starting Qwen3-TTS on port $QWEN_TTS_PORT (ready when it logs \"warm-up done\", about a minute)"
cd services/qwen-tts
exec uv run server.py
