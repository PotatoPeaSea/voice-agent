@echo off
rem Start (or restart) the local Qwen3-TTS service. Double-click or run from any folder.
rem Stops whatever is already listening on the port first, then logs to the console and qwen-tts.log.
setlocal
cd /d "%~dp0"
if not defined QWEN_TTS_PORT set QWEN_TTS_PORT=8765
if not defined QWEN_TTS_LOG set QWEN_TTS_LOG=%~dp0qwen-tts.log

for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127.0.0.1:%QWEN_TTS_PORT% .*LISTENING"') do (
  echo Stopping the TTS service already on port %QWEN_TTS_PORT% ^(PID %%p^)
  taskkill /T /F /PID %%p >nul
)

echo Starting Qwen3-TTS on port %QWEN_TTS_PORT% ^(ready when it logs "warm-up done", about a minute^)
cd services\qwen-tts
uv run server.py
