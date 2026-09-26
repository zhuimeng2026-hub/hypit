"""FFmpeg / ffprobe wrappers for the dub pipeline.

All subprocess invocations capture stdout+stderr, check return code, raise
``FFmpegError`` with the tail of stderr on failure, and use explicit
timeouts. The pipeline layer composes these primitives — backends do not
implement retry/fallback.
"""
from __future__ import annotations

import json
import math
import re
import subprocess
from pathlib import Path

# 1000 chars of stderr is plenty for diagnostics without ballooning log lines.
_STDERR_TAIL = 1000
_MEAN_VOLUME_RE = re.compile(r"mean_volume:\s*(-?\d+\.\d+)\s*dB")


class FFmpegError(Exception):
    """Raised when ffmpeg or ffprobe fails (non-zero exit, timeout, bad JSON)."""


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _run(cmd: list[str], *, timeout: float, label: str) -> subprocess.CompletedProcess:
    """Run a subprocess, capture output, raise FFmpegError on failure.

    ``label`` is used in error messages to distinguish ffmpeg from ffprobe.
    """
    try:
        completed = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise FFmpegError(f"{label} timed out after {timeout}s: cmd={cmd!r}") from error
    if completed.returncode != 0:
        stderr_tail = completed.stderr.decode("utf-8", "replace")[-_STDERR_TAIL:]
        raise FFmpegError(
            f"{label} failed (rc={completed.returncode}): stderr={stderr_tail}"
        )
    return completed


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def probe(path: str | Path, *, ffprobe_bin: str = "ffprobe", timeout: float = 30.0) -> dict:
    """Return ffprobe JSON for ``path``.

    The dict is the parsed output of:

        ffprobe -v error -print_format json -show_format -show_streams <path>

    Raises FFmpegError on non-zero exit, invalid JSON, or timeout.
    """
    cmd = [
        ffprobe_bin,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    completed = _run(cmd, timeout=timeout, label="ffprobe")
    try:
        data = json.loads(completed.stdout.decode("utf-8", "replace"))
    except json.JSONDecodeError as error:
        raise FFmpegError(f"ffprobe returned invalid JSON: {error}") from error
    if not isinstance(data, dict):
        raise FFmpegError("ffprobe returned a non-object payload")
    return data


def extract_canonical_audio(
    src: str | Path,
    dst: str | Path,
    *,
    ffmpeg_bin: str = "ffmpeg",
    timeout: float = 600.0,
) -> Path:
    """Convert any input to canonical 16 kHz mono PCM s16le WAV at ``dst``.

    This is the format the whisperx service requires
    (see /opt/hypit/services/whisperx/src/hypit_whisperx_service/audio.py).

    Command: ``ffmpeg -y -i <src> -ac 1 -ar 16000 -c:a pcm_s16le <dst>``
    """
    dst_path = Path(dst)
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg_bin,
        "-y",
        "-i",
        str(src),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(dst_path),
    ]
    _run(cmd, timeout=timeout, label="ffmpeg")
    if not dst_path.exists():
        raise FFmpegError(f"ffmpeg did not write canonical WAV to {dst_path}")
    return dst_path


def mux_with_ass(
    video_in: str | Path,
    ass: str | Path,
    audio_in: str | Path,
    dst: str | Path,
    *,
    ffmpeg_bin: str = "ffmpeg",
    timeout: float = 600.0,
) -> Path:
    """Burn the ASS subtitles in ``ass`` into ``video_in`` and mux with ``audio_in``.

    Style (font name, size, outline, margin, alignment) is read from the
    ASS file itself — ffmpeg 6.x's ``ass=`` filter dropped the ``force_style``
    option, so per-line styling must travel in the .ass Style: header. The
    upstream pipeline writes that file via :func:`dub_server.pipeline.write_ass`.

    Video: H.264 libx264 -preset medium -crf 20 -pix_fmt yuv420p.
    Audio: AAC 128k.
    """
    dst_path = Path(dst)
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    filter_complex = f"[0:v]ass={ass}[v]"
    cmd = [
        ffmpeg_bin,
        "-y",
        "-i",
        str(video_in),
        "-i",
        str(audio_in),
        "-filter_complex",
        filter_complex,
        "-map",
        "[v]",
        "-map",
        "1:a",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        str(dst_path),
    ]
    _run(cmd, timeout=timeout, label="ffmpeg")
    if not dst_path.exists():
        raise FFmpegError(f"ffmpeg did not write muxed mp4 to {dst_path}")
    return dst_path


def compute_per_second_rms(
    path: str | Path,
    *,
    step: float = 1.0,
    ffmpeg_bin: str = "ffmpeg",
    duration: float | None = None,
    rms_timeout: float = 60.0,
) -> list[float]:
    """Return per-second mean_volume (dB) for the audio in ``path``.

    For each whole-second window, runs ``ffmpeg volumedetect`` over that
    window and parses the ``mean_volume`` field from stderr. Negative dBFS
    are floored at -100 dB to keep the list finite and graphable. Windows
    with unparseable output return ``math.nan``.

    If ``duration`` is not supplied, it is fetched once via :func:`probe`.
    ``step`` is the window length in seconds (default 1.0).
    """
    if duration is None:
        info = probe(path)
        fmt = info.get("format") or {}
        try:
            duration = float(fmt.get("duration", 0.0))
        except (TypeError, ValueError) as error:
            raise FFmpegError(f"ffprobe did not return a usable duration: {info}") from error
    if duration <= 0 or math.isnan(duration):
        return []

    rms_values: list[float] = []
    seconds = int(math.floor(duration / step))
    for t in range(seconds):
        cmd = [
            ffmpeg_bin,
            "-hide_banner",
            "-nostats",
            "-ss",
            f"{t * step:.3f}",
            "-t",
            f"{step:.3f}",
            "-i",
            str(path),
            "-vn",
            "-af",
            "volumedetect",
            "-f",
            "null",
            "-",
        ]
        try:
            completed = _run(cmd, timeout=rms_timeout, label="ffmpeg volumedetect")
        except FFmpegError:
            rms_values.append(math.nan)
            continue
        stderr_text = completed.stderr.decode("utf-8", "replace")
        match = _MEAN_VOLUME_RE.search(stderr_text)
        if not match:
            rms_values.append(math.nan)
            continue
        try:
            db = float(match.group(1))
        except ValueError:
            rms_values.append(math.nan)
            continue
        # Floor at -100 dB; very low values are equivalent for our purposes
        # and avoid -inf floating through downstream lists.
        if db < -100.0:
            db = -100.0
        rms_values.append(db)
    return rms_values