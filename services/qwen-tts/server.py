"""
Local Qwen3-TTS service for the voice agent.

Uses faster-qwen3-tts (CUDA graphs) so generation runs faster than real time
and streams audio while a sentence is still being generated.

POST /synthesize {text, speaker, language?, instruct?} -> streamed raw PCM
(s16le, mono); sample rate in the X-Sample-Rate header. One request per
sentence; the Node side streams sentences in as the LLM writes them.

Run:  uv run server.py        (from services/qwen-tts)
Env:  QWEN_TTS_MODEL       (default Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice)
      QWEN_TTS_CHUNK       codec frames per streamed chunk; 12 frames = 1s audio (default 4)
      QWEN_TTS_HOST / QWEN_TTS_PORT (default 127.0.0.1:8765)
"""

import logging
import os
import threading
import time
from collections.abc import Iterator

import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from faster_qwen3_tts import FasterQwen3TTS
from pydantic import BaseModel

MODEL_ID = os.environ.get("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
CHUNK_FRAMES = int(os.environ.get("QWEN_TTS_CHUNK", "4"))
HOST = os.environ.get("QWEN_TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("QWEN_TTS_PORT", "8765"))
SAMPLE_RATE = 24_000  # Qwen3-TTS 12Hz codec output rate

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("qwen-tts")

if not torch.cuda.is_available():
    raise SystemExit("CUDA GPU required: faster-qwen3-tts uses CUDA graphs")

log.info("loading %s", MODEL_ID)
model = FasterQwen3TTS.from_pretrained(MODEL_ID)
SPEAKERS: list[str] = model.model.get_supported_speakers() or []
gpu_lock = threading.Lock()  # one generation at a time; requests queue in order
app = FastAPI(title="qwen-tts")


class SynthesizeRequest(BaseModel):
    text: str
    speaker: str
    language: str | None = None
    instruct: str | None = None


def to_pcm16(wav: np.ndarray) -> bytes:
    return (np.clip(wav, -1.0, 1.0) * 32767).astype("<i2").tobytes()


def stream_pcm(req: SynthesizeRequest) -> Iterator[bytes]:
    started = time.perf_counter()
    first_audio = None
    samples = 0
    with gpu_lock:
        for chunk, _sr, _timing in model.generate_custom_voice_streaming(
            text=req.text,
            speaker=req.speaker,
            language=req.language or "Auto",
            instruct=req.instruct,
            chunk_size=CHUNK_FRAMES,
        ):
            if first_audio is None:
                first_audio = time.perf_counter() - started
            samples += len(chunk)
            yield to_pcm16(chunk)
    elapsed = time.perf_counter() - started
    audio_s = samples / SAMPLE_RATE
    log.info(
        "first audio %.0fms, %.2fs audio in %.2fs (%.1fx realtime): %r",
        (first_audio or 0) * 1000, audio_s, elapsed, audio_s / max(elapsed, 1e-6), req.text[:60],
    )


def validate(req: SynthesizeRequest) -> None:
    if not req.text.strip():
        raise HTTPException(400, "text is empty")
    if req.speaker.lower() not in SPEAKERS:
        raise HTTPException(400, f"unknown speaker {req.speaker!r}; available: {', '.join(SPEAKERS)}")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": MODEL_ID, "speakers": SPEAKERS}


@app.get("/speakers")
def speakers() -> list[str]:
    return SPEAKERS


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest) -> StreamingResponse:
    validate(req)
    return StreamingResponse(
        stream_pcm(req),
        media_type="application/octet-stream",
        headers={"X-Sample-Rate": str(SAMPLE_RATE)},
    )


if __name__ == "__main__":
    log.info("speakers: %s", ", ".join(SPEAKERS))
    t0 = time.perf_counter()
    model.warmup()  # captures CUDA graphs
    for _ in stream_pcm(SynthesizeRequest(text="Warming up the voice.", speaker=SPEAKERS[0], language="English")):
        pass
    log.info("warm-up done in %.2fs", time.perf_counter() - t0)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
