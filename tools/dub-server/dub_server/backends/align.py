"""TTS segment timeline alignment via a single ffmpeg filter_complex.

For each :class:`TTSSegment`, we build a chain that:

    resamples to 48 kHz stereo → adjusts tempo to match the original
    segment duration (atempo chained for ratios > 2 or < 0.5) → delays
    by ``original_start_ms`` → boosts by 1.4× (final-mux alimiter will
    normalize).

All delayed tracks are mixed with ``amix=inputs=N:duration=longest:
normalize=0`` then padded to ``total_dur`` so the output covers the full
original timeline with silence where no segment plays.

We accept ``tts_duration_ms`` per-segment when the caller has it (from the
MiniMax TTS response); otherwise we ffprobe the segment file. Both paths
produce a single ffmpeg invocation — no per-segment subprocesses.
"""
from __future__ import annotations

import json
import logging
import math
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .ffmpeg import probe

_STDERR_TAIL = 1000
_DURATION_RE = re.compile(r"duration\s*:\s*(-?\d+\.\d+)")

_log = logging.getLogger(__name__)

# Cap on the atempo ratio applied when squeezing TTS audio into its source
# slot. atempo > ~1.5 introduces audible chipmunk / breathing artifacts on
# neural TTS output, so anything above this is left uncapped — the audio
# simply plays at MAX_ATEMPO and the next segment's adelay keeps the slot
# start time stable (slight overlap is preferable to a chipmunked voice).
MAX_ATEMPO = 1.4


@dataclass
class TTSSegment:
    """One TTS-rendered audio clip mapped to its slot in the original timeline.

    Attributes:
        text: source text (kept for logging; the aligner doesn't read it).
        audio_path: path to the per-segment mp3/wav from TTS.
        original_start: original segment start in seconds.
        original_end: original segment end in seconds.
        tts_duration_ms: actual TTS-rendered duration in milliseconds.
            When ``None``, the aligner falls back to ffprobe on
            ``audio_path``. We expose both paths because MiniMax returns
            the duration inline (cheap) while edge-tts requires a probe.
    """

    text: str
    audio_path: str
    original_start: float
    original_end: float
    tts_duration_ms: int | None = None


def _atempo_chain(ratio: float) -> list[str]:
    """Return a list of atempo filters whose product equals ``ratio``.

    atempo accepts 0.5..2.0; we chain ``atempo=2.0`` or ``atempo=0.5`` to
    fold large ratios into multiple legal steps.
    """
    chain: list[str] = []
    r = ratio
    if not math.isfinite(r) or r <= 0:
        raise ValueError(f"atempo ratio must be a positive finite number, got {ratio!r}")
    while r > 2.0:
        chain.append("atempo=2.0")
        r /= 2.0
    while r < 0.5:
        chain.append("atempo=0.5")
        r /= 0.5
    chain.append(f"atempo={r:.4f}")
    return chain


def _ffprobe_duration(path: str | Path) -> float:
    """Return the audio duration of ``path`` in seconds via ffprobe JSON.

    Falls back to stderr parsing if the JSON path doesn't yield a duration
    (some non-audio formats don't report one in the format block).
    """
    info = probe(path)
    fmt = info.get("format") or {}
    try:
        duration = float(fmt.get("duration", 0.0))
        if duration > 0:
            return duration
    except (TypeError, ValueError):
        pass
    # stderr fallback
    try:
        completed = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            timeout=30.0,
            check=False,
        )
        text = (completed.stderr or completed.stdout).decode("utf-8", "replace")
        match = _DURATION_RE.search(text)
        if match:
            return float(match.group(1))
    except subprocess.TimeoutExpired:
        pass
    raise RuntimeError(f"could not determine audio duration for {path}")


def _segment_tts_duration(seg: TTSSegment) -> float:
    if seg.tts_duration_ms is not None and seg.tts_duration_ms > 0:
        return seg.tts_duration_ms / 1000.0
    return _ffprobe_duration(seg.audio_path)


def align_segments_to_original(
    segments: list[TTSSegment],
    total_dur: float,
    out_path: str | Path,
    *,
    ffmpeg_bin: str = "ffmpeg",
    volume: float = 1.4,
    timeout: float = 600.0,
) -> Path:
    """Build one stereo 48 kHz WAV at ``out_path`` matching the original timeline.

    Args:
        segments: TTS audio clips with their original-timeline slots.
        total_dur: full timeline duration in seconds. The output is padded
            to this length with silence via ``apad=whole_dur=...``.
        out_path: destination file path (parent dirs created).
        ffmpeg_bin: ffmpeg executable.
        volume: per-track gain applied after the delay. Default 1.4
            matches the working dub-video pipeline (alimiter in mux
            normalizes).
        timeout: subprocess timeout in seconds.

    Raises:
        RuntimeError: if no segments are supplied, ``total_dur`` is invalid,
            or ffmpeg fails.
        ValueError: if any segment has a non-positive original slot.
    """
    if not segments:
        raise RuntimeError("align_segments_to_original: segments list is empty")
    if total_dur <= 0:
        raise RuntimeError(f"align_segments_to_original: total_dur must be > 0, got {total_dur!r}")

    out_p = Path(out_path)
    out_p.parent.mkdir(parents=True, exist_ok=True)

    filter_lines: list[str] = []
    inputs: list[str] = []
    for i, seg in enumerate(segments):
        if seg.original_end <= seg.original_start:
            raise ValueError(
                f"segment {i} has non-positive slot: "
                f"start={seg.original_start} end={seg.original_end}"
            )
        slot_dur = seg.original_end - seg.original_start
        tts_dur = _segment_tts_duration(seg)
        if tts_dur <= 0:
            raise ValueError(f"segment {i} has non-positive TTS duration: {tts_dur!r}")

        # atempo factor = how much faster TTS must play to fit its slot.
        #   > 1.0 → compress (TTS longer than slot)
        #   < 1.0 → stretch  (TTS shorter than slot)
        # We used to pass ``slot_dur / tts_dur`` here, which inverted the
        # direction and caused every overflowing segment to play slower,
        # blowing past its slot and overlapping the next track.  See the
        # 2026-09-26 gz-exbi-en-final.mp4 regression for the symptom
        # ("two voices at different speeds").
        desired_atempo = tts_dur / slot_dur
        if desired_atempo > MAX_ATEMPO:
            # Cap the speedup. The TTS plays at MAX_ATEMPO for the slot's
            # full duration; any audio that would extend past the slot
            # end is trimmed with ``atrim=end=slot_dur`` so it does not
            # overlap the next segment. Without this, the cap only
            # removes the chipmunk artefact — capped segments still ran
            # past their slot and bled into the next track (e.g. the
            # 30-35s overlap on 2026-09-26 gz-exbi-en-final.mp4).
            _log.warning(
                "align segment=%d atempo capped: tts_dur=%.3fs slot=%.3fs "
                "desired=%.3fx capped=%.3fx trimmed=%.3fs",
                i, tts_dur, slot_dur, desired_atempo, MAX_ATEMPO,
                (tts_dur / MAX_ATEMPO) - slot_dur,
            )
            atempo = MAX_ATEMPO
            trim = f"atrim=end={slot_dur:.4f},asetpts=PTS-STARTPTS,"
        else:
            atempo = desired_atempo
            trim = ""
        atempo_chain = _atempo_chain(atempo)
        delay_ms = int(round(seg.original_start * 1000.0))

        chain = (
            f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,"
            + ",".join(atempo_chain)
            + f",{trim}"
            + f"adelay={delay_ms}|{delay_ms}:all=1,volume={volume}[v{i}]"
        )
        filter_lines.append(chain)
        inputs.extend(["-i", str(seg.audio_path)])

    mix_inputs = "".join(f"[v{i}]" for i in range(len(segments)))
    mix_line = (
        f"{mix_inputs}amix=inputs={len(segments)}:duration=longest:normalize=0,"
        f"apad=whole_dur={total_dur:.3f},"
        f"aresample=48000,aformat=channel_layouts=stereo[out]"
    )
    filter_lines.append(mix_line)
    filter_complex = ";\n".join(filter_lines)

    cmd: list[str] = [
        ffmpeg_bin,
        "-y",
        *inputs,
        "-filter_complex",
        filter_complex,
        "-map",
        "[out]",
        "-c:a",
        "pcm_s16le",
        "-ac",
        "2",
        "-ar",
        "48000",
        str(out_p),
    ]
    try:
        completed = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(
            f"align ffmpeg timed out after {timeout}s"
        ) from error
    if completed.returncode != 0:
        stderr_tail = completed.stderr.decode("utf-8", "replace")[-_STDERR_TAIL:]
        raise RuntimeError(
            f"align ffmpeg failed (rc={completed.returncode}): {stderr_tail}"
        )
    if not out_p.exists():
        raise RuntimeError(f"align ffmpeg did not write output to {out_p}")
    return out_p