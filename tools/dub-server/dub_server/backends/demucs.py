"""Subprocess wrapper around the ``demucs`` CLI for vocal separation.

We shell out to ``demucs`` rather than import the Python API because the
shipped CLI handles model download + cache uniformly across machines, and
the in-process API's lazy model loading would tie demucs lifetime to
importing this module. Subprocess isolation also lets the pipeline layer
cancel work cleanly via timeout.

With ``--two-stems vocals`` demucs writes:

    <out_dir>/<basename>/vocals.wav
    <out_dir>/<basename>/no_vocals.wav

where ``<basename>`` is the audio_path stem. We resolve both by listing
the output dir rather than hard-coding the path, because demucs
``--out`` resolution varies by version.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

_STDERR_TAIL = 1000


class DemucsError(Exception):
    """Raised when the demucs subprocess fails or yields no output files."""


def _run(cmd: list[str], *, timeout: float) -> subprocess.CompletedProcess:
    try:
        completed = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise DemucsError(f"demucs timed out after {timeout}s: cmd={cmd!r}") from error
    if completed.returncode != 0:
        stderr_tail = completed.stderr.decode("utf-8", "replace")[-_STDERR_TAIL:]
        raise DemucsError(
            f"demucs failed (rc={completed.returncode}): stderr={stderr_tail}"
        )
    return completed


def separate(
    audio_path: str | Path,
    *,
    model: str = "htdemucs",
    out_dir: str | Path,
    demucs_bin: str = "demucs",
    timeout: float = 600.0,
) -> tuple[Path, Path]:
    """Run ``demucs -n MODEL --two-stems vocals --device cpu -o OUT_DIR AUDIO``.

    Returns ``(vocals_path, no_vocals_path)`` as absolute Paths.

    Args:
        audio_path: source audio file. Demucs name-suffixes output by the
            model stem, so we resolve the actual output dir from disk.
        model: one of ``htdemucs`` (default, fast) or ``htdemucs_ft``
            (4-model bag, slower but higher quality).
        out_dir: directory where demucs will create ``<basename>/``.
        demucs_bin: path to the ``demucs`` executable.
        timeout: subprocess timeout in seconds (default 600 — the
            ``htdemucs_ft`` 4-model bag takes ~3 minutes for a 20 s clip).

    Raises:
        DemucsError: on non-zero exit, timeout, or missing output files.
    """
    audio_path = Path(audio_path)
    out_dir_path = Path(out_dir)
    out_dir_path.mkdir(parents=True, exist_ok=True)

    cmd = [
        demucs_bin,
        "-n",
        model,
        "--two-stems",
        "vocals",
        "--device",
        "cpu",
        "-o",
        str(out_dir_path),
        str(audio_path),
    ]
    _run(cmd, timeout=timeout)

    # Demucs writes ``<out_dir>/[<model>/]<basename>/{vocals,no_vocals}.wav``
    # (newer versions add a model-suffix dir; older ones don't). Search
    # one level deep for a directory containing both stems so we don't
    # hard-code the depth.
    track_dir = _locate_track_dir(out_dir_path)
    vocals_path = track_dir / "vocals.wav"
    no_vocals_path = track_dir / "no_vocals.wav"
    if not vocals_path.exists() or not no_vocals_path.exists():
        raise DemucsError(
            f"demucs output incomplete: looked for {vocals_path} and "
            f"{no_vocals_path}; directory contents={list(track_dir.iterdir())}"
        )

    return vocals_path.resolve(), no_vocals_path.resolve()


def _locate_track_dir(out_dir_path: Path) -> Path:
    """Find a directory under ``out_dir_path`` that contains vocals.wav.

    Demucs nests the output as either
    ``<out_dir>/<basename>/vocals.wav`` (one level) or
    ``<out_dir>/<model>/<basename>/vocals.wav`` (two levels, model-suffix
    dir first). We pick the shallowest match so users get a deterministic
    answer.
    """
    candidates = sorted(
        (p for p in out_dir_path.iterdir() if p.is_dir()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        raise DemucsError(
            f"demucs produced no output directory under {out_dir_path}"
        )

    # Inspect the most-recently-created dir first.
    for depth_one in candidates:
        if (depth_one / "vocals.wav").exists() and (depth_one / "no_vocals.wav").exists():
            return depth_one
        # Look exactly one level deeper in case the model-suffix dir hides the track.
        for grandchild in sorted(depth_one.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if grandchild.is_dir() and (grandchild / "vocals.wav").exists() and (grandchild / "no_vocals.wav").exists():
                return grandchild

    raise DemucsError(
        f"demucs output did not include vocals.wav/no_vocals.wav under "
        f"{out_dir_path}; explored candidates={[str(c) for c in candidates]}"
    )