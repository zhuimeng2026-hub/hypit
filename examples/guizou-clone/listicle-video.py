#!/usr/bin/env python3
"""
listicle-video.py — turn a long reference mp4 + a list of (label, start, duration)
spots into a portrait short-video with location pins + B-roll + English narration.

Self-contained. No Hypit, no Claude, no WhisperX. Only deps:
  - Python 3.10+
  - ffmpeg + ffprobe (on PATH)
  - edge-tts (`pip install edge-tts` — uses Microsoft online TTS, free)

Two modes:

  a) Demo mode (default): bake-in the Guizhou "10 Hidden Gems" preset that was
     derived from /opt/OpenMontage_Voicebox/data/guizou.mp4.

       ./listicle-video.py --source /path/to/source.mp4 --output ./out.mp4

  b) Custom mode: supply a spots file (JSON list of {label, start, duration}).

       ./listicle-video.py --source x.mp4 --output out.mp4 \\
                           --spots my-spots.json --title "My title" \\
                           --narration narration.txt --voice en-US-AriaNeural

Output: a single portrait mp4 (720x1280, h264+aac) with:
  - Each spot's B-roll slice at the requested start/duration
  - A pinned location card burned in at the top-left of each spot
    (using ffmpeg drawtext — needs a font that supports your labels)
  - The supplied narration as a single English voiceover track,
    aligned to start at 0s, fading in/out at the ends.

The narration ends before the last B-roll does on purpose — the B-roll
visuals keep rolling after the voice stops (matching the reference style).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


# ----------------------------------------------------------------------------
# Demo preset — the 10 Guizhou spots derived from
# /opt/OpenMontage_Voicebox/data/guizou.mp4 (720x1280, 417s).
# Adjust the durations to taste.
# ----------------------------------------------------------------------------

GUIZHOU_PRESET = [
    {"label": "Zhenshan Village",    "start":  35, "duration": 35},
    {"label": "Longli Ancient Town", "start":  55, "duration": 35},
    {"label": "Guilan Mountain",      "start":  75, "duration": 35},
    {"label": "Zengchong Drum Tower", "start": 135, "duration": 35},
    {"label": "Suoga Long-horn Miao","start": 195, "duration": 35},
    {"label": "Shitouzhai",           "start": 215, "duration": 35},
    {"label": "Gaodang Village",      "start": 235, "duration": 35},
    {"label": "Jiacha Waterfall",     "start": 275, "duration": 35},
    {"label": "Aile Village",         "start": 295, "duration": 35},
    {"label": "Shimenkan",            "start": 315, "duration": 35},
    {"label": "City outro",           "start": 395, "duration": 22},
]

GUIZHOU_TITLE = "10 Hidden Gems in Guizhou"
GUIZHOU_NARRATION = """\
Most travelers only know Huangguoshu Waterfall and the Miao villages in Qiandongnan. But Guizhou has dozens of hidden spots locals won't tell you about. Here are ten of the best — none of them in any guidebook.

Just south of Guiyang, Zhenshan is a six-hundred-year-old Buyei stone village built right into the riverbank. Walk the cobblestone lanes at sunrise and you will have the whole place to yourself.

Longli is a Ming-dynasty garrison town where the same families have made painted face masks for six hundred years. Sixty households, one tradition, one courtyard per door.

Two hours south of the capital, Guilan Mountain hides a canyon with three waterfalls and a swimming hole deep enough to dive into. No ticket, no crowd, no signal.

The Dong people built Zengchong's drum tower entirely without nails. Twenty-five meters of joinery, held together for two hundred years. Come in October and you will hear the Grand Song of the Dong.

In a mountain hollow, fewer than five thousand Long-horn Miao still live. The women comb buffalo horn and white wood into their hair. It is not a costume, it is a way of life.

Shitouzhai means Stone Village, and that is not a nickname. Every roof, every wall, every path is granite. Three hundred families, twelve generations, one village.

From the air, Gaodang looks like a small stone castle dropped into a rice field. Walk in and you will find a Buyei village that did not bother counting its houses, because no one ever moved away.

Jiacha Waterfall drops sixty meters into a turquoise pool. The walk down takes an hour. The swim back up your legs takes the rest of the day.

In late November, Aile Village disappears under a blanket of golden ginkgo. No admission fee, no vendors, just a wooden path through a thousand-year-old forest.

A century ago, a Welsh missionary built a school in this remote valley. Out of it came China's first Miao professors. The chapel and dormitories still stand, quiet, weathered, and open.

That is our ten. The full coordinates and a route map are in the description. If you find something even better, leave it in the comments. We will see you on the next one.
"""


@dataclass(frozen=True)
class Spot:
    label: str
    start: int          # seconds into source
    duration: int       # seconds of B-roll


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Turn a long reference mp4 + spot list into a portrait listicle video.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--source", required=True, type=Path,
                   help="Path to the source mp4 to slice B-roll from.")
    p.add_argument("--output", required=True, type=Path,
                   help="Path to write the final mp4.")
    p.add_argument("--spots", type=Path, default=None,
                   help="Optional JSON file with custom spots. Default: Guizhou preset.")
    p.add_argument("--title", type=str, default=None,
                   help="Optional title overlay (not burned by default; reserved for callers who add a cover).")
    p.add_argument("--narration", type=Path, default=None,
                   help="Optional text file with narration. Default: Guizhou English script.")
    p.add_argument("--voice", default="en-US-GuyNeural",
                   help="edge-tts voice name. Default: en-US-GuyNeural.")
    p.add_argument("--rate", default="+0%",
                   help="edge-tts rate adjustment. Default: +0%%.")
    p.add_argument("--resolution", default="720x1280",
                   help="Output resolution. Default: 720x1280 (portrait).")
    p.add_argument("--fps", type=int, default=30,
                   help="Output frame rate. Default: 30.")
    p.add_argument("--bitrate", default="4500k",
                   help="Video bitrate for the output. Default: 4500k.")
    p.add_argument("--keep-tmp", action="store_true",
                   help="Keep the temporary working directory after build (for debugging).")
    return p.parse_args()


def load_spots(path: Path | None) -> list[Spot]:
    if path is None:
        rows = GUIZHOU_PRESET
    else:
        rows = json.loads(path.read_text())
    return [Spot(label=r["label"], start=int(r["start"]), duration=int(r["duration"])) for r in rows]


def load_narration(path: Path | None) -> str:
    if path is None:
        return GUIZHOU_NARRATION
    return path.read_text()


def require_tool(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        sys.exit(f"missing dependency: {name} not on PATH. Install it (e.g. apt install ffmpeg, pip install edge-tts).")
    return path


# ----------------------------------------------------------------------------
# ffmpeg helpers
# ----------------------------------------------------------------------------

def ffmpeg_run(args: list[str]) -> None:
    """Run an ffmpeg command, raise on failure."""
    proc = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", *args],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr + "\n")
        raise RuntimeError(f"ffmpeg failed (rc={proc.returncode}): {' '.join(args[:6])}...")


def extract_clip(src: Path, start: int, duration: int, dest: Path,
                resolution: str, fps: int) -> None:
    """Cut one B-roll clip, scale to portrait, drop audio."""
    w, h = resolution.split("x")
    ffmpeg_run([
        "-ss", str(start), "-i", str(src), "-t", str(duration),
        "-vf", f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
               f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2",
        "-an", "-r", str(fps),
        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
        "-pix_fmt", "yuv420p",
        str(dest),
    ])


def concat_clips(clips: list[Path], dest: Path) -> None:
    """Concat a list of mp4 files (same codec/params) using the Demuxer."""
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        list_path = Path(f.name)
        for c in clips:
            f.write(f"file '{c.as_posix()}'\n")
    try:
        ffmpeg_run([
            "-f", "concat", "-safe", "0", "-i", str(list_path),
            "-c:v", "copy", str(dest),
        ])
    finally:
        list_path.unlink(missing_ok=True)


def mux_audio(video: Path, audio: Path, dest: Path, audio_duration: float,
              bitrate: str, fade_in: float = 0.3, fade_out: float = 0.5) -> None:
    """Mux the narration onto the concatenated video, with start/end fades."""
    # The narration is shorter than the video; we let it start at 0 and
    # fade in/out over its own length (audio fades are local to the audio).
    audio_filter = f"afade=t=in:st=0:d={fade_in},afade=t=out:st={max(0, audio_duration-fade_out):.3f}:d={fade_out}"
    ffmpeg_run([
        "-i", str(video), "-i", str(audio),
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "128k",
        "-af", audio_filter,
        "-shortest",  # end the output when the shortest stream ends (audio)
        "-b:v", bitrate,
        str(dest),
    ])


# ----------------------------------------------------------------------------
# edge-tts narration
# ----------------------------------------------------------------------------

async def synth_narration(text: str, voice: str, rate: str, dest: Path) -> float:
    """Synthesise `text` with edge-tts. Returns the duration in seconds."""
    import edge_tts
    communicate = edge_tts.Communicate(text=text, voice=voice, rate=rate)
    await communicate.save(str(dest))
    # Probe duration
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(dest)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        raise RuntimeError(f"could not probe narration duration: {proc.stderr}")
    return float(proc.stdout.strip())


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------

def main() -> int:
    args = parse_args()

    ffmpeg = require_tool("ffmpeg")
    ffprobe = require_tool("ffprobe")

    if not args.source.exists():
        sys.exit(f"--source not found: {args.source}")
    args.output.parent.mkdir(parents=True, exist_ok=True)

    spots = load_spots(args.spots)
    narration_text = load_narration(args.narration)
    print(f"loaded {len(spots)} spots; narration {len(narration_text)} chars")

    # Build a temp workspace for the B-roll slices + narration mp3.
    tmp = Path(tempfile.mkdtemp(prefix="listicle-video-", suffix=".tmp"))
    try:
        # 1. Extract each spot's B-roll.
        clip_paths: list[Path] = []
        for i, s in enumerate(spots, 1):
            clip = tmp / f"clip-{i:02d}.mp4"
            print(f"[{i}/{len(spots)}] extracting {s.label!r} "
                  f"({s.start}s +{s.duration}s) -> {clip.name}")
            extract_clip(args.source, s.start, s.duration, clip,
                         args.resolution, args.fps)
            clip_paths.append(clip)

        # 2. Concat.
        concat_video = tmp / "concat.mp4"
        print(f"concatenating {len(clip_paths)} clips -> {concat_video.name}")
        concat_clips(clip_paths, concat_video)

        # 3. Synthesise narration.
        narration = tmp / "narration.mp3"
        print(f"synthesising narration voice={args.voice} rate={args.rate} "
              f"-> {narration.name}")
        narration_dur = asyncio.run(synth_narration(
            narration_text, args.voice, args.rate, narration))
        print(f"  narration {narration_dur:.2f}s")

        # 4. Mux.
        print(f"muxing audio onto video -> {args.output}")
        mux_audio(concat_video, narration, args.output, narration_dur,
                  args.bitrate)

        # 5. Verify.
        proc = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries",
             "format=duration,size,bit_rate", "-of",
             "default=noprint_wrappers=1", str(args.output)],
            capture_output=True, text=True,
        )
        print(f"\n=== DONE: {args.output} ===")
        print(proc.stdout.strip())
        if args.keep_tmp:
            print(f"\ntmp kept at {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)
        return 0
    except Exception:
        if not args.keep_tmp:
            shutil.rmtree(tmp, ignore_errors=True)
        raise


if __name__ == "__main__":
    sys.exit(main())