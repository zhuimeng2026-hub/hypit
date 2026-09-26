"""Async + sync wrappers around the ``edge-tts`` CLI.

The edge-tts binary is a self-contained Node-style command-line tool — we
shell out to it via ``asyncio.create_subprocess_exec`` so callers running
inside an event loop can ``await`` multiple syntheses concurrently. The
sync wrapper is for pipeline stages that are themselves synchronous.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

_STDERR_TAIL = 1000


class EdgeTTSError(Exception):
    """Raised when the edge-tts subprocess fails, times out, or yields no file."""


async def synthesize(
    text: str,
    voice: str,
    out_mp3: str | Path,
    *,
    rate: str = "+50%",
    edge_tts_bin: str = "edge-tts",
    timeout: float = 30.0,
) -> Path:
    """Spawn ``edge-tts --voice VOICE --rate RATE --text TEXT --write-media OUT``.

    Async; suitable for batching many TTS calls. Raises :class:`EdgeTTSError`
    on non-zero exit, timeout, or if the output file does not appear.
    """
    out_path = Path(out_mp3)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        edge_tts_bin,
        "--voice",
        voice,
        "--rate",
        rate,
        "--text",
        text,
        "--write-media",
        str(out_path),
    ]

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as error:
        raise EdgeTTSError(
            f"edge-tts executable not found: {edge_tts_bin!r}"
        ) from error

    try:
        _stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError as error:
        process.kill()
        await process.wait()
        raise EdgeTTSError(f"edge-tts timed out after {timeout}s: voice={voice!r}") from error

    if process.returncode != 0:
        stderr_tail = (stderr or b"").decode("utf-8", "replace")[-_STDERR_TAIL:]
        raise EdgeTTSError(
            f"edge-tts failed (rc={process.returncode}): voice={voice!r} stderr={stderr_tail}"
        )

    if not out_path.exists():
        raise EdgeTTSError(
            f"edge-tts did not write audio to {out_path}"
        )

    return out_path


def synthesize_sync(
    text: str,
    voice: str,
    out_mp3: str | Path,
    **kwargs,
) -> Path:
    """Synchronous wrapper around :func:`synthesize`.

    Uses ``asyncio.run`` so callers that aren't already on a running loop can
    drop in without orchestration. Pipeline stages are sync, so this is
    the entry point they call.
    """
    return asyncio.run(synthesize(text, voice, out_mp3, **kwargs))