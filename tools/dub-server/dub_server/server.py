"""FastMCP server for the dub pipeline.

Each MCP tool delegates to a function in ``dub_server.pipeline``:

- :func:`dub_video`       → :func:`pipeline.dub_video`
- :func:`transcribe_audio`→ :func:`pipeline.transcribe_audio`
- :func:`separate_audio`  → :func:`pipeline.separate_audio`

Synchronous calls; concurrency is bounded to **one job in flight** by a
module-global ``JOB_LOCK``. The rationale: whisperx is single-inference
(503 BUSY otherwise), demucs holds the model in memory, and two dub
calls don't gain anything from running in parallel on this CPU host.

stdout is the MCP protocol in stdio mode — logging is to stderr only.
``logging_setup.setup_logging`` enforces that.
"""
from __future__ import annotations

import logging
from typing import Any

from mcp.server.fastmcp import FastMCP

from .config import Config
from .jobs import JOB_LOCK, JobRegistry
from .pipeline import (
    PipelineError,
    dub_video as pipeline_dub_video,
    separate_audio as pipeline_separate,
    transcribe_audio as pipeline_transcribe,
)
from .schemas import (
    DubRequest,
    DubResult,
    SeparateRequest,
    SeparateResult,
    TranscribeRequest,
    TranscribeResult,
)

# ---------------------------------------------------------------------------
# Module-level state — built lazily on first tool call so ``import server``
# doesn't trigger env reads or job-sweeping (helps tests).
# ---------------------------------------------------------------------------

_config: Config | None = None
_registry: JobRegistry | None = None


def _state() -> tuple[Config, JobRegistry]:
    global _config, _registry
    if _config is None:
        _config = Config.from_env()
    if _registry is None:
        _registry = JobRegistry(_config.job_root, max_jobs=10)
        _registry.sweep()
    return _config, _registry


# ---------------------------------------------------------------------------
# MCP app
# ---------------------------------------------------------------------------

mcp = FastMCP(
    name="hypit-dub",
    instructions=(
        "Video dubbing service. Replace the audio track of a short video with "
        "target-language TTS, optionally separated from the source audio bed "
        "via demucs (ML) or stereo phase cancellation, with burned-in ASS "
        "subtitles from the translated transcript. Three tools: dub_video "
        "(end-to-end), separate_audio (return vocals + no_vocals stems), "
        "transcribe_audio (run whisperx ASR on a video/audio file)."
    ),
)


def _record_job(job, *, ok: bool, payload: dict[str, Any] | None, error: str | None,
                registry: JobRegistry) -> None:
    if ok and payload is not None:
        registry.complete(job.job_id, payload)
    else:
        registry.fail(job.job_id, error or "unknown failure")


# ---------------------------------------------------------------------------
# Tool: dub_video
# ---------------------------------------------------------------------------


@mcp.tool(
    name="dub_video",
    description=(
        "End-to-end dub a video. Extract audio → optionally separate vocals "
        "(via demucs ML or stereo phase cancellation) → whisperx ASR → "
        "MiniMax translate (or skip when target==source) → TTS each segment "
        "(MiniMax direct, falling back to edge-tts) → align to original "
        "timeline → mix with audio bed → mux with burned-in ASS subtitles."
    ),
)
def dub_video(req: DubRequest) -> dict[str, Any]:
    """Run the full dub pipeline on ``req.source_video_path``.

    Returns a JSON-serialisable dict with::

        output_path:         absolute path to the new mp4
        transcript:          list of segments (translated when applicable)
        model_used:          separation model actually used
        voice_used:          TTS voice id (or id+fallback marker)
        timings_ms:          per-stage wall-clock milliseconds
        loudness_per_sec_db: per-second mean_volume across the output
        bed_minus_voice_db:  voice-vs-bed quality metric (ml-separate only)
        job_id:              server-side job identifier
        warnings:            non-fatal issues (e.g. miniMax → edge fallback)
    """
    config, registry = _state()
    with JOB_LOCK:
        job = registry.create()
        registry.start(job.job_id)
        try:
            result: DubResult = pipeline_dub_video(req, config=config, job=job)
            payload = result.model_dump(mode="json")
            registry.complete(job.job_id, payload)
            return payload
        except PipelineError as error:
            registry.fail(job.job_id, str(error))
            return {
                "error": "pipeline",
                "message": str(error),
                "job_id": job.job_id,
            }
        except Exception as error:  # noqa: BLE001 — surface everything
            registry.fail(job.job_id, f"unexpected: {error}")
            return {
                "error": "internal",
                "message": repr(error),
                "job_id": job.job_id,
            }


# ---------------------------------------------------------------------------
# Tool: transcribe_audio
# ---------------------------------------------------------------------------


@mcp.tool(
    name="transcribe_audio",
    description=(
        "Run whisperx ASR on a video or audio file. Returns segments with "
        "word-level timestamps and the detected language (or the requested "
        "one when supplied)."
    ),
)
def transcribe_audio(req: TranscribeRequest) -> dict[str, Any]:
    """Lower-level: just ASR. Skips translate/TTS/mix."""
    config, registry = _state()
    with JOB_LOCK:
        job = registry.create()
        registry.start(job.job_id)
        try:
            result: TranscribeResult = pipeline_transcribe(req, config=config, job=job)
            payload = result.model_dump(mode="json")
            registry.complete(job.job_id, payload)
            return payload
        except PipelineError as error:
            registry.fail(job.job_id, str(error))
            return {"error": "pipeline", "message": str(error), "job_id": job.job_id}
        except Exception as error:  # noqa: BLE001
            registry.fail(job.job_id, f"unexpected: {error}")
            return {"error": "internal", "message": repr(error), "job_id": job.job_id}


# ---------------------------------------------------------------------------
# Tool: separate_audio
# ---------------------------------------------------------------------------


@mcp.tool(
    name="separate_audio",
    description=(
        "Run demucs on a video or audio file and return the vocals + "
        "no_vocals stems. No mux, no TTS, no translate."
    ),
)
def separate_audio(req: SeparateRequest) -> dict[str, Any]:
    """Lower-level: only run demucs and return the two stems."""
    config, registry = _state()
    with JOB_LOCK:
        job = registry.create()
        registry.start(job.job_id)
        try:
            result: SeparateResult = pipeline_separate(req, config=config, job=job)
            payload = result.model_dump(mode="json")
            registry.complete(job.job_id, payload)
            return payload
        except PipelineError as error:
            registry.fail(job.job_id, str(error))
            return {"error": "pipeline", "message": str(error), "job_id": job.job_id}
        except Exception as error:  # noqa: BLE001
            registry.fail(job.job_id, f"unexpected: {error}")
            return {"error": "internal", "message": repr(error), "job_id": job.job_id}


# ---------------------------------------------------------------------------
# Module exports for ``python -m dub_server`` and the MCP client config
# ---------------------------------------------------------------------------

__all__ = ["mcp", "dub_video", "transcribe_audio", "separate_audio"]
