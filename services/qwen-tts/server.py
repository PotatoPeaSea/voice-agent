"""
Local Qwen3-TTS service for the voice agent.

Uses faster-qwen3-tts (CUDA graphs) so generation runs faster than real time
and streams audio while a sentence is still being generated.

POST /synthesize {text, speaker, language?, instruct?} -> streamed raw PCM
(s16le, mono); sample rate in the X-Sample-Rate header. One request per
sentence; the Node side streams sentences in as the LLM writes them.

Speakers are the model's presets plus cloned voices: each voices/<name>.wav
(a clean ~10-15s clip) with voices/<name>.txt (its exact transcript) becomes
speaker <name>, spoken by the Base model. Make them with `npm run clone-voice`.
New files are picked up without a restart.

Run:  uv run server.py        (from services/qwen-tts)
Env:  QWEN_TTS_MODEL       (default Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice)
      QWEN_TTS_CLONE_MODEL Base model for cloned voices (default Qwen/Qwen3-TTS-12Hz-0.6B-Base; "off" disables)
      QWEN_TTS_VOICES_DIR  cloned voice references (default ./voices)
      QWEN_TTS_CHUNK       codec frames per streamed chunk; 12 frames = 1s audio (default 4)
      QWEN_TTS_HOST / QWEN_TTS_PORT (default 127.0.0.1:8765)
      QWEN_TTS_LOG         also append the log to this file (start-tts sets ../../qwen-tts.log)
"""

import asyncio
import logging
import os
import threading
import time
from collections.abc import AsyncIterator, Callable
from pathlib import Path

import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from faster_qwen3_tts import FasterQwen3TTS
from pydantic import BaseModel

MODEL_ID = os.environ.get("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
CLONE_MODEL_ID = os.environ.get("QWEN_TTS_CLONE_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-Base")
VOICES_DIR = Path(os.environ.get("QWEN_TTS_VOICES_DIR", Path(__file__).parent / "voices"))
CHUNK_FRAMES = int(os.environ.get("QWEN_TTS_CHUNK", "4"))
HOST = os.environ.get("QWEN_TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("QWEN_TTS_PORT", "8765"))
SAMPLE_RATE = 24_000  # Qwen3-TTS 12Hz codec output rate

LOG_FILE = os.environ.get("QWEN_TTS_LOG")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(), *([logging.FileHandler(LOG_FILE, encoding="utf-8")] if LOG_FILE else [])],
)
log = logging.getLogger("qwen-tts")

if not torch.cuda.is_available():
    raise SystemExit("CUDA GPU required: faster-qwen3-tts uses CUDA graphs")

log.info("loading %s", MODEL_ID)
model = FasterQwen3TTS.from_pretrained(MODEL_ID)
SPEAKERS: list[str] = model.model.get_supported_speakers() or []
clone_model = None
if CLONE_MODEL_ID.lower() != "off":
    log.info("loading %s for cloned voices", CLONE_MODEL_ID)
    clone_model = FasterQwen3TTS.from_pretrained(CLONE_MODEL_ID)
gpu_lock = threading.Lock()  # one generation at a time; requests queue in order
CODEC_HZ = 12
app = FastAPI(title="qwen-tts")


class SynthesizeRequest(BaseModel):
    text: str
    speaker: str
    language: str | None = None
    instruct: str | None = None


def cloned_voices() -> dict[str, tuple[Path, str]]:
    """name -> (reference wav, transcript) for every complete pair in VOICES_DIR."""
    if clone_model is None or not VOICES_DIR.is_dir():
        return {}
    voices = {}
    for wav in VOICES_DIR.glob("*.wav"):
        txt = wav.with_suffix(".txt")
        if txt.is_file():
            voices[wav.stem.lower()] = (wav, txt.read_text(encoding="utf-8").strip())
    return voices


def all_speakers() -> list[str]:
    return SPEAKERS + sorted(set(cloned_voices()) - set(SPEAKERS))


def max_tokens(text: str) -> int:
    """Cap a generation at ~0.25s of audio per character (3x normal speech, min 8s) so a
    sentence that never emits end-of-speech (cloned voices sometimes ramble) can't hog the GPU."""
    return min(2048, int(CODEC_HZ * max(8.0, len(text) * 0.25)))


def generate(req: SynthesizeRequest):
    clone = cloned_voices().get(req.speaker.lower())
    if clone:
        ref_audio, ref_text = clone
        # The Base model takes no instruct; the reference clip sets the style.
        return clone_model.generate_voice_clone_streaming(
            text=req.text,
            language=req.language or "Auto",
            ref_audio=ref_audio,
            ref_text=ref_text,
            chunk_size=CHUNK_FRAMES,
            max_new_tokens=max_tokens(req.text),
        )
    return model.generate_custom_voice_streaming(
        text=req.text,
        speaker=req.speaker,
        language=req.language or "Auto",
        instruct=req.instruct,
        chunk_size=CHUNK_FRAMES,
        max_new_tokens=max_tokens(req.text),
    )


def to_pcm16(wav: np.ndarray) -> bytes:
    return (np.clip(wav, -1.0, 1.0) * 32767).astype("<i2").tobytes()


def run_generation(req: SynthesizeRequest, emit: Callable[[bytes], None], cancelled: Callable[[], bool]) -> None:
    """Generate under the GPU lock, handing PCM to emit. Always releases the lock: stops at
    the next chunk once cancelled() (client hung up, e.g. barge-in) and closes the generator."""
    started = time.perf_counter()
    first_audio = None
    samples = 0
    stopped = False
    with gpu_lock:
        gen = generate(req)
        try:
            for chunk, _sr, _timing in gen:
                if cancelled():
                    stopped = True
                    break
                if first_audio is None:
                    first_audio = time.perf_counter() - started
                samples += len(chunk)
                emit(to_pcm16(chunk))
        finally:
            gen.close()
    elapsed = time.perf_counter() - started
    audio_s = samples / SAMPLE_RATE
    log.info(
        "[%s] %sfirst audio %.0fms, %.2fs audio in %.2fs (%.1fx realtime): %r",
        req.speaker, "CANCELLED " if stopped else "", (first_audio or 0) * 1000, audio_s, elapsed,
        audio_s / max(elapsed, 1e-6), req.text[:60],
    )


async def stream_pcm(req: SynthesizeRequest) -> AsyncIterator[bytes]:
    """Runs the generation on its own thread. If the client disconnects, Starlette cancels this
    generator and the finally block tells the thread to stop, so the GPU lock is never left held
    by an abandoned response (which used to stall every later request)."""
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[bytes | Exception | None] = asyncio.Queue()
    cancel = threading.Event()
    put = lambda item: loop.call_soon_threadsafe(queue.put_nowait, item)  # noqa: E731

    def worker() -> None:
        try:
            run_generation(req, put, cancel.is_set)
        except Exception as err:  # surfaced to the client as a cut-off stream
            log.exception("generation failed: %r", req.text[:60])
            put(err)
        finally:
            put(None)

    threading.Thread(target=worker, daemon=True).start()
    try:
        while (item := await queue.get()) is not None:
            if isinstance(item, Exception):
                raise item
            yield item
    finally:
        cancel.set()


def validate(req: SynthesizeRequest) -> None:
    if not req.text.strip():
        raise HTTPException(400, "text is empty")
    if req.speaker.lower() not in all_speakers():
        raise HTTPException(400, f"unknown speaker {req.speaker!r}; available: {', '.join(all_speakers())}")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": MODEL_ID, "clone_model": CLONE_MODEL_ID if clone_model else None, "speakers": all_speakers()}


@app.get("/speakers")
def speakers() -> list[str]:
    return all_speakers()


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest) -> StreamingResponse:
    validate(req)
    return StreamingResponse(
        stream_pcm(req),
        media_type="application/octet-stream",
        headers={"X-Sample-Rate": str(SAMPLE_RATE)},
    )


if __name__ == "__main__":
    log.info("speakers: %s", ", ".join(all_speakers()))
    t0 = time.perf_counter()
    model.warmup()  # captures CUDA graphs
    warm = [SPEAKERS[0]]
    if clone_model is not None:
        clone_model.warmup()
        warm += sorted(cloned_voices())  # also caches each reference's voice prompt
    for speaker in warm:
        run_generation(SynthesizeRequest(text="Warming up the voice.", speaker=speaker, language="English"), lambda _: None, lambda: False)
    log.info("warm-up done in %.2fs", time.perf_counter() - t0)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
