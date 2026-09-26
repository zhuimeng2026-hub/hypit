"""End-to-end orchestrator for the dub pipeline.

Each public function in this module is the **library** form of one MCP tool.
The FastMCP server (``server.py``) is a thin wrapper around these: validate
input → grab JOB_LOCK → call the pipeline function → convert to JSON.

Pipeline stages, in order, for ``dub_video``:

    1. Probe source video, extract canonical 16 kHz mono WAV
    2. Prepare the audio bed (mode = stereo-mix | ml-separate | phase-cancel)
    3. WhisperX transcribe → segments with word timings
    4. MiniMax translate each segment (skip if source_lang == target_lang)
    5. TTS each segment (MiniMax preferred, edge-tts on failure)
    6. Align TTS clips onto the original timeline
    7. Mix bed + aligned voice into a single audio track
    8. Mux video + final audio + ASS-burned subtitles
    9. Compute per-second RMS loudness profile

Per-stage timings land in ``DubResult.timings_ms``.
"""
from __future__ import annotations

import math
import os
import re
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import logging

from .backends import (
    DEFAULT_VOICES,
    DemucsError,
    EdgeTTSError,
    FFmpegError,
    MiniMaxChatError,
    MiniMaxTTSError,
    WhisperXBusy,
    WhisperXError,
    TTSSegment,
    align_segments_to_original,
    compute_per_second_rms,
    demucs_separate,
    edge_tts_synthesize_sync,
    extract_canonical_audio,
    minimax_tts_synthesize,
    mux_with_ass,
    probe,
    translate_segments,
    whisperx_transcribe,
)
from .config import Config
from .jobs import Job
from .logging_setup import setup_logging
from .schemas import (
    LoudnessPoint,
    Segment,
    WordTiming,
    DubRequest,
    DubResult,
    SeparateRequest,
    SeparateResult,
    TranscribeRequest,
    TranscribeResult,
)

# Per-mode bed gain that matches the working dub-video pipeline values
# (see out-zh.mp4 / -chear / -ML in /opt/hypit/examples/ranking-football/).
# `ml-separate` mutes the bed to 0.0 — the demucs-split no_vocals stem
# often still carries vocoder artifacts of the original voice, and the
# BGM at any non-trivial level competes with the new voice, producing
# the "sound overlap" complaint observed on the 2026-09-26 gz-exbi.mp4
# dub. Users who want BGM retained should switch to stereo-mix (which
# ducks the original bed to 0.30 and keeps both voice and music) or set
# MINIMAX_TTS_VOICE_/bed_vol in their fork. `phase-cancel` keeps its 8×
# boost to recover the ~18 dB L-R subtraction loss.
MODE_BED_VOLUME = {
    "stereo-mix": 0.30,
    "phase-cancel": 8.0,
    "ml-separate": 0.0,
}
VOICE_VOLUME = 1.20

# Per-language edge-tts fallback voice. Match the working pipeline: Yunjian
# for zh-CN (sports/passion male), Guy for en-US (sports commentary tone).
EDGE_VOICE_FALLBACK = {
    "zh-male": "zh-CN-YunjianNeural",
    "zh-female": "zh-CN-XiaoxiaoNeural",
    "en-male": "en-US-GuyNeural",
    "en-female": "en-US-JennyNeural",
}


class PipelineError(Exception):
    """Raised on recoverable orchestration failures (missing input, bad request)."""


# ---------------------------------------------------------------------------
# Voice resolution
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VoiceChoice:
    minimax_id: str
    edge_fallback: str | None
    requested_label: str  # "auto:zh-male" | "explicit:male_zh_3" | ...


def resolve_voice(
    voice_input: str,
    target_language: str,
    *,
    minimax_voices: dict[str, str],
) -> VoiceChoice:
    """Map the public ``voice`` field to MiniMax + edge-tts voice ids.

    Accepted values:
      - ``"auto"``        → pick a sensible male/female default per language
      - one of ``minimax_voices`` keys (``zh-male`` / ``zh-female`` /
        ``en-male`` / ``en-female``)
      - any other string  → treated as an explicit MiniMax ``voice_id``; no edge fallback

    ``minimax_voices`` carries the resolved voice-id map (typically the
    MiniMax overrides that came through :class:`Config` from
    ``MINIMAX_TTS_VOICE_*`` env vars). The backend's :data:`DEFAULT_VOICES`
    constant is the fallback if a key isn't present in the env-derived map.
    """
    label = voice_input
    code = target_language.split("-", 1)[0].lower()
    if voice_input == "auto":
        key = f"{code}-male"  # default to male
        label = f"auto:{key}"
    else:
        key = voice_input

    minimax_id = minimax_voices.get(key) or DEFAULT_VOICES.get(key)
    edge_fallback = EDGE_VOICE_FALLBACK.get(key)

    if minimax_id is None and edge_fallback is None:
        # Treat as a direct MiniMax voice id with no edge fallback.
        return VoiceChoice(
            minimax_id=voice_input,
            edge_fallback=None,
            requested_label=f"explicit:{voice_input}",
        )
    return VoiceChoice(
        minimax_id=minimax_id or voice_input,
        edge_fallback=edge_fallback,
        requested_label=label,
    )


# ---------------------------------------------------------------------------
# Bed preparation
# ---------------------------------------------------------------------------


def _phase_cancel_bed(src_audio: Path, dst: Path, *, ffmpeg_bin: str, boost: float = 8.0) -> Path:
    """L-R subtraction cancels center-panned vocals; boost restores lost energy."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg_bin, "-y", "-loglevel", "error",
        "-i", str(src_audio),
        "-af", f"pan=stereo|c0=c0-c1|c1=c1-c0,volume={boost}",
        "-ar", "48000", "-ac", "2",
        str(dst),
    ]
    res = subprocess.run(cmd, capture_output=True, timeout=600.0, check=False)
    if res.returncode != 0:
        raise FFmpegError(
            f"phase-cancel ffmpeg failed (rc={res.returncode}): "
            f"{res.stderr.decode('utf-8', 'replace')[-1000:]!r}"
        )
    if not dst.exists():
        raise FFmpegError(f"phase-cancel ffmpeg did not produce {dst}")
    return dst


@dataclass
class BedArtefact:
    """Result of bed preparation. ``vocals_path`` is set only when separation
    actually happened (ml-separate mode); ``None`` otherwise."""
    bed_path: Path
    vocals_path: Path | None


def prepare_bed(
    canonical_wav: Path,
    workspace: Path,
    *,
    mode: str,
    model: str,
    config: Config,
) -> BedArtefact:
    """Stage 2: produce the audio bed for the final mix."""
    if mode == "stereo-mix":
        return BedArtefact(bed_path=canonical_wav, vocals_path=None)
    if mode == "phase-cancel":
        bed = _phase_cancel_bed(canonical_wav, workspace / "bed.wav", ffmpeg_bin=config.ffmpeg_bin)
        return BedArtefact(bed_path=bed, vocals_path=None)
    if mode == "ml-separate":
        sep_dir = workspace / "demucs"
        vocals, no_vocals = demucs_separate(
            str(canonical_wav),
            model=model,
            out_dir=sep_dir,
            demucs_bin=config.demucs_bin,
        )
        return BedArtefact(bed_path=no_vocals, vocals_path=vocals)
    raise PipelineError(f"unknown mode: {mode!r}")


# ---------------------------------------------------------------------------
# Bed+voice mix + mux helpers
# ---------------------------------------------------------------------------


def _mix_bed_and_voice(
    bed_path: Path,
    voice_path: Path,
    dst: Path,
    *,
    config: Config,
    bed_vol: float = 1.0,
    voice_vol: float = VOICE_VOLUME,
) -> Path:
    """Stage 7: mix bed + aligned voice into a single 48 kHz stereo WAV."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        config.ffmpeg_bin, "-y", "-loglevel", "error",
        "-i", str(bed_path),
        "-i", str(voice_path),
        "-filter_complex",
        f"[0:a]volume={bed_vol}[bed];[1:a]volume={voice_vol}[vox];"
        f"[bed][vox]amix=inputs=2:duration=longest:normalize=0,"
        f"alimiter=limit=0.95,aresample=48000,aformat=channel_layouts=stereo[aout]",
        "-map", "[aout]",
        "-c:a", "pcm_s16le",
        "-ac", "2",
        "-ar", "48000",
        str(dst),
    ]
    res = subprocess.run(cmd, capture_output=True, timeout=600.0, check=False)
    if res.returncode != 0:
        raise FFmpegError(
            f"bed+voice mix failed (rc={res.returncode}): "
            f"{res.stderr.decode('utf-8', 'replace')[-1000:]!r}"
        )
    if not dst.exists():
        raise FFmpegError(f"mix did not produce {dst}")
    return dst


def _mux_simple(
    video_in: Path,
    audio_in: Path,
    dst: Path,
    *,
    config: Config,
) -> Path:
    """Mux video with audio only (no subtitle burn). Used when ``burn_subtitles``=False."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        config.ffmpeg_bin, "-y", "-loglevel", "error",
        "-i", str(video_in),
        "-i", str(audio_in),
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "128k",
        "-shortest",
        str(dst),
    ]
    res = subprocess.run(cmd, capture_output=True, timeout=600.0, check=False)
    if res.returncode != 0:
        raise FFmpegError(
            f"mux_simple failed (rc={res.returncode}): "
            f"{res.stderr.decode('utf-8', 'replace')[-1000:]!r}"
        )
    return dst


# ---------------------------------------------------------------------------
# ASS subtitle writer
# ---------------------------------------------------------------------------


def _format_ass_time(seconds: float) -> str:
    """Render seconds as ``H:MM:SS.cc`` for ASS Dialogue lines."""
    if seconds < 0:
        seconds = 0.0
    total_ms = int(round(seconds * 1000))
    cs = total_ms % 1000 // 10  # centiseconds
    total_s = total_ms // 1000
    s = total_s % 60
    m = (total_s // 60) % 60
    h = total_s // 3600
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def write_ass(
    ass_path: Path,
    segments: list[Segment],
    *,
    target_language: str,
    use_translation: bool,
) -> None:
    """Write a Chinese-friendly ASS subtitle file from the dub segments.

    When ``use_translation`` is True, prefer ``segment.translation`` (set by
    translate_segments). Otherwise fall back to ``segment.text`` (used when
    target_lang == source_lang).

    Lines that exceed ~14 Chinese characters are wrapped with ``\\N`` so the
    bottom margin layout (per recipes.svs caption-primary style) doesn't
    truncate them.
    """
    style_line = (
        "Style: Default,Noto Sans CJK SC,32,&H00FFFFFF,&H000000FF,"
        "&H001D1D1D,&H00000000,1,0,0,0,100,100,0,0,1,2,1,2,40,40,80,1"
    )

    lines = [
        "[Script Info]",
        "ScriptType: V4.00+",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "PlayResX: 720",
        "PlayResY: 1280",
        "YCbCr Matrix: TV.709",
        "",
        "[V4+ Styles]",
        (
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
            "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
            "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
            "Alignment, MarginL, MarginR, MarginV, Encoding"
        ),
        style_line,
        "",
        "[Events]",
        (
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
            "Effect, Text"
        ),
    ]

    for seg in segments:
        text = (seg.translation if use_translation else None) or seg.text
        if not text:
            continue
        start = _format_ass_time(seg.start)
        end = _format_ass_time(seg.end)
        # Pick wrap limit by script: CJK glyphs are ~2× wider than Latin at
        # the same font size, so the per-line char budget differs. ffmpeg
        # 6.x's ``ass=`` filter does not respect ``WrapStyle: 2`` reliably,
        # so both branches emit hard ``\\N`` rather than trusting libass
        # to word-wrap a too-wide line.
        max_chars = 14 if _has_cjk(text) else 40
        wrapped = _wrap_for_ass(text, max_chars=max_chars)
        lines.append(
            f"Dialogue: 0,{start},{end},Default,,0,0,0,,{wrapped}"
        )

    ass_path.parent.mkdir(parents=True, exist_ok=True)
    ass_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _has_cjk(text: str) -> bool:
    """Heuristic: True if the string is dominated by CJK code points."""
    cjk = sum(1 for ch in text if "一" <= ch <= "鿿" or "぀" <= ch <= "ヿ")
    return cjk > 0


def _wrap_for_ass(text: str, *, max_chars: int) -> str:
    """Wrap subtitle text into ASS-friendly line breaks.

    Both scripts emit hard ``\\N`` breaks. ffmpeg 6.x's ``ass=`` filter
    does not respect ASS ``WrapStyle: 2`` reliably, so deferring to
    libass produces lines wider than the burn area that spill off the
    right edge (regression observed on the 2026-09-26 gz-exbi.mp4 dub
    at frames 6.0s, 35.0s — see ``tools/dub-server/docs/``).

    - For ASCII / Latin text we word-wrap on spaces, capping each line
      at ``max_chars`` (caller passes 40 at FontSize=32 in 720×1280).
    - For CJK text we hard-wrap at ``max_chars`` (caller passes 14 —
      CJK glyphs are wide and ``SpaceWrapStyle: 2`` does not help us
      when there are no spaces).
    """
    if len(text) <= max_chars:
        return text.replace("\n", "\\N")
    if not _has_cjk(text):
        # Latin: word-wrap on spaces, cap each line at max_chars.
        return _wrap_latin_on_word(text, max_chars=max_chars)
    # CJK: split at CJK punctuation if a natural break is nearby, else hard split.
    midpoint = len(text) // 2
    for offset in range(min(midpoint, 4)):
        for delta in (midpoint + offset, midpoint - offset):
            if 0 < delta < len(text) and text[delta] in (" ", "，", "。", "、", "！", "？"):
                head = text[:delta].rstrip(" ，。、！？")
                tail = text[delta:].lstrip()
                return (head + "\\N" + _wrap_for_ass(tail, max_chars=max_chars)).replace("\n", "\\N")
    return text[:max_chars] + "\\N" + _wrap_for_ass(text[max_chars:], max_chars=max_chars)


def _wrap_latin_on_word(text: str, *, max_chars: int) -> str:
    """Word-wrap Latin / ASCII text so each line fits within ``max_chars``.

    Splits on whitespace; lines are joined by ASS hard-break ``\\N``.
    Words longer than ``max_chars`` are emitted on their own line (we
    never break inside a word) — at typical translation lengths this
    shouldn't happen, but if a single word is wider than the burn area
    we let libass handle it as best it can.
    """
    words = text.split()
    lines: list[str] = []
    current: list[str] = []
    current_len = 0
    for word in words:
        # +1 for the joining space (no space if first word on a line)
        added = len(word) + (1 if current else 0)
        if current and current_len + added > max_chars:
            lines.append(" ".join(current))
            current = [word]
            current_len = len(word)
        else:
            current.append(word)
            current_len += added
    if current:
        lines.append(" ".join(current))
    return "\\N".join(lines)


# ---------------------------------------------------------------------------
# Translation completeness: detection + retry
# ---------------------------------------------------------------------------

# Loose CJK regex (covers CJK Unified Ideographs, extension A/B/C/D/E/F, plus
# Hiragana/Katakana/Kana). Any of these in a translation = the model fell
# back to source-script text instead of rendering in target_language.
_CJK_ECHO_RE = re.compile(r"[㐀-鿿぀-ヿ]")
# A translation is "complete" if its last character is terminal punctuation.
# MiniMax chat frequently emits English sentences terminated by Chinese
# full-width punctuation (。？！) — accept those as equivalent to .!? so we
# don't retry-translate responses that are actually fine.
_TERMINAL_PUNCT = ".!?。？！"
# Models often truncate mid-word and end with a period, which fools the
# punctuation check. Detect that explicitly: a leading 1-2 letters (any
# case) followed by a space — e.g. "d and" ← "inflated" or "Th Visit" ←
# "the"; legitimate translations almost never start with a 1-letter word.
_WORD_CUT_PREFIX_RE = re.compile(r"^[A-Za-z]{1,2}\s")


def _is_incomplete_translation(seg: Segment) -> tuple[bool, str]:
    """Detect translations that are missing closing punctuation or contain
    CJK fallback characters (the model gave up on the target language).
    Returns (is_incomplete, reason) so callers can log the diagnosis.
    """
    trans = (seg.translation or "").rstrip()
    if not trans:
        return True, "empty"
    # Strip trailing quotes / parentheses before inspecting the terminating
    # character — those don't count as "missing closure".
    tail = trans
    while tail and tail[-1] in "'\")]}":
        tail = tail[:-1].rstrip()
    if not tail:
        return False, ""
    if tail[-1] not in _TERMINAL_PUNCT:
        return True, f"missing terminal punctuation, last={tail[-1]!r}"
    # Word-cut heuristic: leading 1-2 letters (any case) followed by a space
    # is almost always a mid-word cut from the model's perspective (rare in
    # otherwise-natural English output). Threshold of 15 chars skips trivial
    # cases like "a b" but catches "d and not worth it." mid-word cuts.
    # Whitelist contains **capitalised** English words only. Lowercase 1- or
    # 2-letter words starting a sentence should always be flagged: legitimate
    # English starts sentences with capital letters.
    _WORD_STARTS_OK = frozenset({
        "I", "A",                                                     # 1-letter caps
        "An", "It", "Is", "As", "Or", "If", "Of", "To", "Be", "In", "On", "So",
        "No", "Do", "We", "By", "At", "Up", "My", "Me", "He",                # 2-letter caps
    })
    if len(trans) >= 15:
        head = trans.lstrip()[:3]
        first_word = head.split(' ')[0]
        if _WORD_CUT_PREFIX_RE.match(head) and first_word not in _WORD_STARTS_OK:
            return True, f"appears to start mid-word: {trans[:20]!r}"
    if _CJK_ECHO_RE.search(trans):
        return True, "CJK fallback characters in translation"
    return False, ""


def _retry_incomplete_translations(
    segments: list[Segment],
    *,
    config: "Config",
    target_lang_code: str,
    source_lang_code: str,
    logger: logging.Logger,
    max_attempts: int = 2,
) -> list[Segment]:
    """Re-translate any segments whose initial MiniMax response looked
    incomplete (no terminal punctuation OR CJK fallback). Each retry
    re-calls translate_segments with just that segment and a stricter
    system prompt that emphasises "produce a complete sentence — do not
    echo source-script characters".

    Up to ``max_attempts`` rounds; segments that stay incomplete after
    that are kept with their best-effort translation and an added warning.
    """
    incomplete = [(i, _is_incomplete_translation(s)[1])
                  for i, s in enumerate(segments) if _is_incomplete_translation(s)[0]]
    if not incomplete:
        return segments

    logger.info("translation completeness pass: %d segments need retry (%s)",
                len(incomplete), "; ".join(f"#{i}({r})" for i, r in incomplete[:6]))

    # Build a stronger system message: same as the standard one but with the
    # explicit "do not echo source text" rule embedded up front, plus an
    # explicit "replace any remaining CJK chars with pinyin or English"
    # instruction. Each retry pass also has a small jitter hint so the
    # model is less likely to produce identical bad output twice.
    BASE_STRICT_SYSTEM = (
        "You are a careful translator for video dubbing. Translate the next "
        "numbered input into {tl}. The input is short — produce exactly one "
        "complete, finished sentence in {tl}. Never leave the sentence "
        "unfinished — the output must end in a period, exclamation, or "
        "question mark. CRITICAL: your output must contain ZERO characters "
        "from the source script (no CJK / Han / Hangul / Kana / Cyrillic "
        "for any reason). If a word feels unfamiliar, transliterate it "
        "(pinyin, romaji, etc.) or rephrase it in {tl}. {jitter}"
    )
    JITTER_PHRASES = [
        "Take a deep breath and proceed methodically.",
        "Be precise; do not abbreviate.",
        "Output every word you would have written without errors.",
        "Treat this as a transcript for voice-over, not a chat reply.",
    ]

    for attempt in range(1, max_attempts + 1):
        pending = []
        jitter = JITTER_PHRASES[(attempt - 1) % len(JITTER_PHRASES)]
        strict_msg = (
            BASE_STRICT_SYSTEM.replace("{jitter}", jitter).replace("{tl}", target_lang_code)
        )
        for i, reason in incomplete:
            seg = segments[i]
            single = [seg]
            try:
                out = translate_segments(
                    single, target_lang_code,
                    base_url=config.minimax_base_url,
                    api_key=config.minimax_api_key,
                    model=config.minimax_chat_model,
                    timeout=config.minimax_timeout_seconds,
                    source_language=source_lang_code,
                    system_prompt=strict_msg,
                )
                new_trans = out[0].translation if out else None
                if new_trans and not _is_incomplete_translation(
                    seg.model_copy(update={"translation": new_trans})
                )[0]:
                    segments[i] = seg.model_copy(update={"translation": new_trans})
                    logger.info("retry[%d]: segment %d fixed (%s)", attempt, i, reason)
                else:
                    pending.append((i, reason))
            except MiniMaxChatError as error:
                logger.warning("retry[%d]: segment %d failed: %s", attempt, i, error)
                pending.append((i, reason))
        if not pending:
            incomplete = []
            break
        incomplete = pending

    # Anything still incomplete after max_attempts → keep best-effort + warn.
    # Recount on the final state (the `incomplete` list is just stale trace
    # info once we've broken out of the loop). Returns the per-segment
    # reason text so the caller can surface them on ``result.warnings``.
    final_failed = [
        (i, _is_incomplete_translation(s)[1])
        for i, s in enumerate(segments) if _is_incomplete_translation(s)[0]
    ]
    if final_failed:
        logger.warning("translation still incomplete after %d retries: %s",
                       max_attempts, final_failed)
    return segments, final_failed


# ---------------------------------------------------------------------------
# Quality metric
# ---------------------------------------------------------------------------


def _mean(values: Iterable[float]) -> float:
    items = [v for v in values if isinstance(v, (int, float)) and not math.isnan(v)]
    if not items:
        return float("nan")
    return sum(items) / len(items)


# ---------------------------------------------------------------------------
# Long-segment splitter — fixes whisperx "small" mega-segments that would
# otherwise overrun MiniMax chat output tokens and produce 20+ second subtitles.
# ---------------------------------------------------------------------------

# Chinese sentence-final + soft clause punctuation. Treated as a sub-segment
# boundary. We include comma/顿号 because real-world narration (e.g. the
# guangzhou travel monologue) often runs sentences together with commas
# rather than periods, and we still want reasonable subtitle widths.
# Both ASCII ' , ' and full-width ' ， ' are included because the whisperx
# "small" model sometimes emits ASCII punctuation for what is otherwise
# Chinese text.
_CJK_BOUNDARIES = set("。！？!?；;,，、")
# Common Chinese enumeration opens ("一、", "二、", ... up to 20).
_CJK_ENUM_RE = re.compile(
    r"(?<![一二三四五六七八九十百千零两])(?:"
    r"[一二三四五六七八九十]|十[一二三四五六七八九]?"
    r")、"
)
# Whitespace + simple punctuation runs (commas in long clauses) — used to
# find a soft split when no internal boundary exists in the segment window.
_SOFT_SPLIT_RE = re.compile(r"\s*[,;:]\s*")


def _split_into_breath_groups(
    segments: list[Segment],
    *,
    language: str,
    target_chars: int = 8,
    max_chars: int = 14,
) -> list[Segment]:
    """Split each segment into breath-group-sized chunks.

    A breath group is what a speaker would say in one breath: typically
    5–10 CJK characters or 4–7 English words. For CJK we prefer to cut
    at clause-level punctuation (commas 、， ;； and enumeration 一、二、)
    so each chunk ends on a natural pause; if the segment has too few
    punctuation marks we fall back to length-based splits at ``target_chars``.

    Replaces :func:`_split_long_segments`: that function only split
    segments longer than 8 s and spread the resulting sub-segments
    evenly across the original window, which forced the align stage to
    over-compress every TTS clip. Breath groups are short enough to fit
    their slot at atempo ≤ ~1.3× in most cases, so the ``MAX_ATEMPO``
    cap rarely bites.

    Uses ``Segment.words`` (whisperx word-level timings) to compute
    precise start/end for each sub-segment. Falls back to even
    distribution when word timings are absent.
    """
    is_cjk = language.startswith(("zh", "ja", "ko"))
    out: list[Segment] = []
    for seg in segments:
        if seg.end <= seg.start:
            out.append(seg)
            continue
        if len(seg.text) <= max_chars:
            out.append(seg)
            continue

        if is_cjk:
            cuts = _find_breath_cuts(
                seg.text, target_chars=target_chars, max_chars=max_chars
            )
        else:
            cuts = _find_latin_breath_cuts(seg.text, target_words=target_chars - 2)
        if not cuts or len(cuts) < 2:
            out.append(seg)
            continue

        for cut_lo, cut_hi in cuts:
            piece_text = seg.text[cut_lo:cut_hi].strip()
            if not piece_text:
                continue
            sub_start, sub_end = _piece_time_window(seg, cut_lo, cut_hi)
            piece_words = [
                w for w in seg.words
                if sub_start - 0.001 <= w.start <= sub_end + 0.001
            ]
            out.append(
                Segment(
                    text=piece_text,
                    start=round(sub_start, 3),
                    end=round(sub_end, 3),
                    words=piece_words,
                )
            )
    return out


def _find_breath_cuts(
    text: str,
    *,
    target_chars: int,
    max_chars: int,
) -> list[tuple[int, int]] | None:
    """Cut CJK text into breath-group-sized pieces ending at clause
    punctuation when possible.

    Boundaries are clause punctuation (CJK: 、，；。!?！？ and ASCII , ; . ! ?)
    plus enumeration markers 一、二、...

    The split algorithm picks, for each cut, the **latest** punctuation
    position that lies in ``[cursor+min_chars, cursor+max_chars]``, where
    ``min_chars = max(target_chars // 2, 3)``. If no punctuation lands in
    that window it force-cuts at ``cursor+max_chars`` so a piece can never
    exceed the cap.

    Earliest revisions of this helper always took the *first* punctuation
    past ``target_chars``; sparse-punctuation segments slipped out at
    20+ characters and the breath-group TTS blew past its slot, forcing
    the align cap and atrim to chop the last ~1 s of English speech.
    Taking the latest in-window punctuation produces natural-feeling
    pieces while still respecting the cap.
    """
    # Build a sorted list of cut positions (offsets AFTER the boundary char)
    cuts: set[int] = {0}
    for i, ch in enumerate(text):
        if ch in "、，；,;．.！!？?":
            j = i + 1
            while j < len(text) and text[j] in " \t":
                j += 1
            cuts.add(j)
    for m in _CJK_ENUM_RE.finditer(text):
        if m.start() > 0:
            cuts.add(m.start())
    cuts.add(len(text))
    cuts_sorted = sorted(cuts)

    min_chars = max(target_chars // 2, 3)
    pieces: list[tuple[int, int]] = []
    cursor = 0
    while cursor < len(text):
        best: int | None = None
        for c in cuts_sorted:
            if c <= cursor:
                continue
            length = c - cursor
            if length > max_chars:
                break  # cuts_sorted is sorted; nothing closer fits
            if length >= min_chars:
                best = c  # keep updating to the latest in-window punctuation
        if best is None:
            # No punctuation in [min_chars, max_chars] window: force-cut
            # at max_chars (or end of text) so we never exceed the cap.
            best = min(cursor + max_chars, len(text))
        pieces.append((cursor, best))
        cursor = best
    # Drop leading/trailing whitespace-only pieces
    pieces = [(lo, hi) for lo, hi in pieces if text[lo:hi].strip()]
    return pieces if len(pieces) >= 2 else None


def _find_latin_breath_cuts(text: str, *, target_words: int) -> list[tuple[int, int]] | None:
    """Cut Latin text into breath-group-sized pieces ending at clause
    punctuation when possible."""
    # Build cut positions at clause punctuation
    cuts: list[int] = [0]
    for i, ch in enumerate(text):
        if ch in ",;:.!?":
            j = i + 1
            while j < len(text) and text[j] == " ":
                j += 1
            cuts.append(j)
    cuts = sorted(set(cuts))
    if cuts[-1] != len(text):
        cuts.append(len(text))

    pieces: list[tuple[int, int]] = []
    cursor = cuts[0]
    for nxt in cuts[1:]:
        # Count words in this candidate piece
        candidate = text[cursor:nxt]
        word_count = len(candidate.split())
        if word_count >= target_words or (nxt - cursor) >= target_chars * 4:
            pieces.append((cursor, nxt))
            cursor = nxt
    if cursor < len(text):
        pieces.append((cursor, len(text)))
    pieces = [(lo, hi) for lo, hi in pieces if text[lo:hi].strip()]
    return pieces if len(pieces) >= 2 else None


def _piece_time_window(
    seg: Segment,
    cut_lo: int,
    cut_hi: int,
) -> tuple[float, float]:
    """Map text-offset ``[cut_lo, cut_hi)`` to (start, end) seconds.

    Walks ``seg.words`` accumulating character counts so each character
    in ``seg.text`` maps to the word that contains it. The first word
    whose range contains ``cut_lo`` defines ``sub_start``; the last word
    whose range overlaps ``cut_hi`` defines ``sub_end``. Falls back to
    even distribution if word timings are missing or the mapping is
    ambiguous.
    """
    words = seg.words
    if not words:
        total = max(len(seg.text), 1)
        frac_lo = cut_lo / total
        frac_hi = cut_hi / total
        return (
            seg.start + (seg.end - seg.start) * frac_lo,
            seg.start + (seg.end - seg.start) * frac_hi,
        )

    sub_start = seg.start
    sub_end = seg.end
    cum = 0
    found_lo = False
    found_hi = False
    for w in words:
        wlen = len(w.text)
        if not found_lo and cum <= cut_lo < cum + wlen:
            sub_start = w.start
            found_lo = True
        if cum < cut_hi <= cum + wlen:
            sub_end = w.end
            found_hi = True
        cum += wlen
    # Boundary cases: cut_lo == 0 → use first word; cut_hi at end → last word
    if not found_lo and cut_lo == 0:
        sub_start = words[0].start
    if not found_hi or cut_hi >= cum:
        sub_end = words[-1].end
    return sub_start, sub_end


def _split_long_segments(
    segments: list[Segment],
    *,
    language: str,
    max_seconds: float = 8.0,
    max_chars: int = 40,
) -> list[Segment]:
    """Break any segment longer than ``max_seconds`` OR ``max_chars`` at
    Chinese sentence/enumeration boundaries. For non-CJK languages (English
    etc.) we keep segments as-is and split only on long whitespace runs.

    Returns a new list. Word-level timings are NOT split here — call
    :func:`_reindex_word_timings` afterwards.
    """
    is_cjk = language.startswith(("zh", "ja", "ko"))
    out: list[Segment] = []
    for seg in segments:
        dur = seg.end - seg.start
        if dur <= max_seconds and len(seg.text) <= max_chars:
            out.append(seg)
            continue

        if is_cjk:
            cuts = _find_cjk_cuts(seg.text, min_chars=max_chars // 3)
        else:
            cuts = _find_soft_cuts(seg.text)

        if cuts and len(cuts) > 1:
            for piece_start, piece_end in cuts:
                if piece_end <= piece_start:
                    continue
                piece_text = seg.text[piece_start:piece_end].strip()
                if not piece_text:
                    continue
                # Spread sub-segments evenly inside the original window.
                frac_lo = piece_start / max(len(seg.text), 1)
                frac_hi = piece_end / max(len(seg.text), 1)
                sub_start = seg.start + (seg.end - seg.start) * frac_lo
                sub_end = seg.start + (seg.end - seg.start) * frac_hi
                out.append(
                    Segment(
                        text=piece_text,
                        start=round(sub_start, 3),
                        end=round(sub_end, 3),
                    )
                )
        else:
            # No internal cuts available; fall back to splitting at half if
            # it's clearly too long, otherwise keep the original segment.
            if dur > max_seconds * 2 and len(seg.text) > max_chars * 2:
                mid = seg.start + (seg.end - seg.start) / 2
                half = len(seg.text) // 2
                out.append(
                    Segment(text=seg.text[:half].strip(), start=seg.start, end=round(mid, 3))
                )
                out.append(
                    Segment(text=seg.text[half:].strip(), start=round(mid, 3), end=seg.end)
                )
            else:
                out.append(seg)
    return out


def _find_cjk_cuts(text: str, *, min_chars: int) -> list[tuple[int, int]] | None:
    """Find sentence-style cuts in CJK text, merging tiny slivers.

    Boundaries come from sentence-final + soft clause punctuation
    (``。！？!?；;，、``) and enumeration markers (``一、`` etc.). After
    gathering offsets we merge adjacent pieces shorter than ``min_chars``
    so each sub-segment is meaningful to read.
    """
    boundaries: list[int] = [0]
    for i, ch in enumerate(text):
        if ch in _CJK_BOUNDARIES:
            j = i + 1
            while j < len(text) and text[j] in " \t":
                j += 1
            boundaries.append(j)
    for m in _CJK_ENUM_RE.finditer(text):
        if m.start() > 0:
            boundaries.append(m.start())
    boundaries = sorted(set(boundaries))
    if len(boundaries) < 2:
        return None
    boundaries.append(len(text))
    pieces = [(boundaries[k], boundaries[k + 1]) for k in range(len(boundaries) - 1)]
    # Merge adjacent tiny pieces so each sub-segment is readable.
    merged: list[tuple[int, int]] = []
    cursor_start, cursor_end = pieces[0]
    for start, end in pieces[1:]:
        segment_text_len = (cursor_end - cursor_start)
        next_len = end - start
        if segment_text_len < min_chars and next_len < min_chars:
            cursor_end = end  # keep extending this one
        else:
            merged.append((cursor_start, cursor_end))
            cursor_start, cursor_end = start, end
    merged.append((cursor_start, cursor_end))
    return merged if len(merged) >= 2 else None


def _find_soft_cuts(text: str) -> list[tuple[int, int]] | None:
    """Find soft (comma/colon) cuts in Latin text. Used only as a fallback."""
    pieces: list[tuple[int, int]] = []
    cursor = 0
    for m in _SOFT_SPLIT_RE.finditer(text):
        end = m.end()
        if end - cursor > 80:
            pieces.append((cursor, end))
            cursor = end
    if cursor < len(text):
        pieces.append((cursor, len(text)))
    return pieces if len(pieces) >= 2 else None


def _reindex_word_timings(segments: list[Segment]) -> list[Segment]:
    """For each sub-segment, keep only the words that fall inside its
    [start, end] window. Words outside the window are dropped. Returns
    new Segment objects (does not mutate)."""
    out: list[Segment] = []
    for seg in segments:
        if not seg.words:
            out.append(seg)
            continue
        kept = [w for w in seg.words if seg.start - 0.001 <= w.start <= seg.end + 0.001]
        out.append(
            Segment(
                text=seg.text,
                start=seg.start,
                end=seg.end,
                words=kept,
                translation=seg.translation,
            )
        )
    return out


# ---------------------------------------------------------------------------


def compute_bed_minus_voice_db(
    vocals_path: Path | None,
    bed_path: Path,
    *,
    config: Config,
    window_sec: int = 5,
) -> float | None:
    """Estimate voice-band isolation: how many dB quieter the bed is than the voice.

    Only meaningful for ml-separate mode (we have an isolated vocals stem).
    Returns ``None`` for stereo-mix / phase-cancel (no clean vocal reference).
    Uses mean RMS over seconds [5, 5+window] to skip the start of the clip
    where both bed and voice can be silent.
    """
    if vocals_path is None or not vocals_path.exists():
        return None
    try:
        voice_rms = compute_per_second_rms(vocals_path, ffmpeg_bin=config.ffmpeg_bin)
        bed_rms = compute_per_second_rms(bed_path, ffmpeg_bin=config.ffmpeg_bin)
    except FFmpegError:
        return None
    v_mean = _mean(voice_rms[5:5 + window_sec])
    b_mean = _mean(bed_rms[5:5 + window_sec])
    if math.isnan(v_mean) or math.isnan(b_mean) or v_mean == 0:
        return None
    return round(b_mean - v_mean, 2)


# ---------------------------------------------------------------------------
# Public pipeline functions (one per MCP tool)
# ---------------------------------------------------------------------------


def dub_video(
    req: DubRequest,
    *,
    config: Config,
    job: Job,
) -> DubResult:
    """End-to-end dub: extract → optional separation → ASR → translate → TTS →
    align → mix → mux. Returns a :class:`DubResult` JSON-serialisable object.

    The caller owns ``job`` (this function just stamps timings on it via
    timestamps the JobRegistry already records).

    Cross-process serialized via POSIX flock on ``$JOB_ROOT/.dub.lock``
    so concurrent CLI / MCP / sub-process invocations don't double-hit
    whisperx (single-inference). Override path with ``DUB_LOCK_PATH``
    for system-wide locking. Set ``DUB_LOCK_BLOCKING=1`` to wait instead
    of failing fast when the lock is held.
    """
    from .joblock import cross_process_lock, default_lock_path, DubJobBusy

    workspace = job.workspace
    workspace.mkdir(parents=True, exist_ok=True)
    logger = setup_logging(job_log_path=job.log_path)
    logger.info(
        "dub_video start job_id=%s src=%s mode=%s model=%s target=%s voice=%s",
        job.job_id, req.source_video_path, req.mode, req.model,
        req.target_language, req.voice,
    )

    lock_path = default_lock_path(config.job_root)
    blocking = os.environ.get("DUB_LOCK_BLOCKING") == "1"
    try:
        with cross_process_lock(lock_path, blocking=blocking):
            logger.info("cross-process lock acquired: %s", lock_path)
            return _dub_video_pipeline(
                req, config=config, job=job, logger=logger, workspace=workspace,
            )
    except DubJobBusy as e:
        logger.error("could not acquire cross-process lock %s: %s", lock_path, e)
        raise PipelineError(
            f"another dub is in progress on this workspace ({lock_path}); "
            f"wait for it to finish, or set DUB_LOCK_BLOCKING=1 to queue. ({e})"
        ) from e


def _dub_video_pipeline(
    req: DubRequest,
    *,
    config: Config,
    job: Job,
    logger: logging.Logger,
    workspace: Path,
) -> DubResult:
    """The actual dub pipeline body, called under the cross-process lock."""
    timings: dict[str, int] = {}
    warnings: list[str] = []
    src = Path(req.source_video_path).expanduser().resolve()
    if not src.exists():
        logger.error("source video missing: %s", src)
        raise PipelineError(f"source video not found: {src}")

    # ---- Stage 1: probe + extract canonical audio ----
    t0 = time.monotonic()
    logger.info("stage=extract start in=%s", src)
    info = probe(str(src), ffprobe_bin=config.ffprobe_bin)
    try:
        duration = float((info.get("format") or {}).get("duration", 0.0))
    except (TypeError, ValueError):
        raise PipelineError(f"could not determine duration of {src}") from None
    canonical_wav = workspace / "audio.wav"
    extract_canonical_audio(src, canonical_wav, ffmpeg_bin=config.ffmpeg_bin)
    timings["extract"] = int((time.monotonic() - t0) * 1000)
    logger.info("stage=extract done dur=%.2fs wav=%s", duration, canonical_wav)

    # ---- Stage 2: prepare bed ----
    t0 = time.monotonic()
    logger.info("stage=bed start mode=%s model=%s", req.mode, req.model)
    bed = prepare_bed(
        canonical_wav, workspace,
        mode=req.mode, model=req.model, config=config,
    )
    timings["bed"] = int((time.monotonic() - t0) * 1000)
    logger.info("stage=bed done bed=%s vocals=%s",
                bed.bed_path, bed.vocals_path or "n/a")

    # ---- Stage 3: whisperx ----
    t0 = time.monotonic()
    logger.info("stage=transcribe start url=%s lang=%s",
                config.whisperx_url, req.source_language or "auto")
    try:
        wx_resp = whisperx_transcribe(
            str(canonical_wav), language=req.source_language,
            base_url=config.whisperx_url,
        )
    except WhisperXBusy as error:
        raise PipelineError(f"whisperx busy: {error}") from error
    except WhisperXError as error:
        raise PipelineError(f"whisperx failed: {error}") from error
    timings["transcribe"] = int((time.monotonic() - t0) * 1000)

    detected_lang: str | None = wx_resp.get("language")
    segments_raw = wx_resp.get("segments", [])
    segments: list[Segment] = []
    for sd in segments_raw:
        words = [
            WordTiming(
                text=str(w.get("text") or w.get("word") or ""),
                start=float(w.get("start", 0.0)),
                end=float(w.get("end", 0.0)),
                score=(float(w["score"]) if w.get("score") is not None else None),
            )
            for w in sd.get("words", [])
        ]
        segments.append(
            Segment(
                text=str(sd.get("text", "")).strip(),
                start=float(sd.get("start", 0.0)),
                end=float(sd.get("end", 0.0)),
                words=words,
            )
        )

    if not segments:
        raise PipelineError("whisperx returned zero segments; cannot dub an empty transcript")
    timings["transcribe"] = int((time.monotonic() - t0) * 1000)
    logger.info("stage=transcribe done lang=%s segments=%d dur=%.1fs",
                detected_lang, len(segments), duration)

    # Breath-group breaker: split every long segment into chunks a
    # speaker would naturally say in one breath (5–10 CJK chars / 4–7
    # English words), cutting at clause punctuation (commas 、 enumeration
    # markers 一、二、) when possible. This makes each TTS clip short
    # enough to fit its slot at atempo ≤ ~1.3×, so the MAX_ATEMPO cap
    # rarely bites and the align stage never truncates English.
    detected_lang_code = (detected_lang or "en").lower()
    raw_segment_count = len(segments)
    segments = _split_into_breath_groups(segments, language=detected_lang_code)
    # Re-index word timings after splitting so each new sub-segment carries
    # only the words that fall inside its window.
    segments = _reindex_word_timings(segments)
    if len(segments) != raw_segment_count:
        logger.info("stage=split done raw=%d after_split=%d", raw_segment_count, len(segments))

    # ---- Stage 4: translate segments ----
    target_lang_code = req.target_language.split("-", 1)[0].lower()
    source_lang_code = (detected_lang or "en").lower()
    if target_lang_code != source_lang_code:
        if not config.minimax_api_key:
            raise PipelineError(
                f"translation source={source_lang_code} -> target={target_lang_code} "
                "requires MINIMAX_API_KEY"
            )
        # Chunked translation: even with max_tokens set, MiniMax's chat
        # endpoint seems to silently truncate responses at a hard limit
        # (~600-700 chars) regardless of the requested max_tokens. We
        # work around that with one segment per call. 12 sequential
        # requests at ~2-3 s each is acceptable for any short-form video
        # and gives the strongest guarantee that nothing is dropped mid-
        # sentence in the response. If MiniMax ever lifts the cap,
        # grouping by 3 again will be measurably faster.
        t0 = time.monotonic()
        logger.info("stage=translate start segments=%d source=%s target=%s model=%s",
                    len(segments), source_lang_code, target_lang_code, config.minimax_chat_model)
        translated: list = []
        try:
            for i, chunk in enumerate([segments[i:i + 1] for i in range(len(segments))]):
                logger.debug("stage=translate calling chat batch=%d text=%r",
                             i, chunk[0].text[:60])
                out = translate_segments(
                    chunk, target_lang_code,
                    base_url=config.minimax_base_url,
                    api_key=config.minimax_api_key,
                    model=config.minimax_chat_model,
                    timeout=config.minimax_timeout_seconds,
                    source_language=source_lang_code,
                )
                translated.extend(out)
                if (i + 1) % 4 == 0 and i + 1 < len(segments):
                    logger.info("translate progress: %d/%d batches done", i + 1, len(segments))
        except MiniMaxChatError as error:
            logger.exception("stage=translate failed batch_index=%d", i)
            raise PipelineError(f"translate failed: {error}") from error
        timings["translate"] = int((time.monotonic() - t0) * 1000)
        logger.info("stage=translate done dur=%.1fs translated=%d",
                    timings["translate"] / 1000.0, len(translated))
        # Post-translation cleanup: detect translations that ended mid-clause
        # or contain CJK fallback characters (the model "gives up" and prints
        # the source text). Retry those segments with a stricter prompt until
        # they look complete or we've burned the budget.
        segments, retry_warnings = _retry_incomplete_translations(
            translated,
            config=config,
            target_lang_code=target_lang_code,
            source_lang_code=source_lang_code,
            logger=logger,
        )
        warnings.extend(
            f"segment {i} translation stayed incomplete after retries ({reason})"
            for i, reason in retry_warnings
        )
        use_translation = True
    else:
        logger.info("stage=translate skipped (source==target)")
        timings["translate"] = 0
        use_translation = False

    # ---- Stage 5: TTS each segment ----
    t0 = time.monotonic()
    minimax_voice_catalog = {
        "zh-male":   config.minimax_tts_voice_zh_male,
        "zh-female": config.minimax_tts_voice_zh_female,
        "en-male":   config.minimax_tts_voice_en_male,
        "en-female": config.minimax_tts_voice_en_female,
    }
    choice = resolve_voice(
        req.voice, req.target_language, minimax_voices=minimax_voice_catalog,
    )
    logger.info("stage=tts start voice=%s model=%s speed=%s segments=%d",
                choice.minimax_id, config.minimax_tts_model,
                config.minimax_tts_speed, len(segments))
    logger.debug(
        "tts voice resolved edge-fallback=%s label=%s",
        choice.edge_fallback, choice.requested_label,
    )
    tts_segments: list[TTSSegment] = []
    fallback_used = False
    for i, seg in enumerate(segments):
        text_to_speak = (seg.translation if use_translation else seg.text) or ""
        if not text_to_speak.strip():
            logger.debug("stage=tts segment=%d skipped (empty text)", i)
            continue
        seg_mp3 = workspace / f"tts-{i:02d}.mp3"
        tts_duration_ms: int | None = None
        if config.minimax_api_key and choice.minimax_id:
            try:
                logger.debug("stage=tts segment=%d minimax text=%r", i, text_to_speak[:50])
                _mp3, tts_duration_ms = minimax_tts_synthesize(
                    text=text_to_speak,
                    voice_id=choice.minimax_id,
                    out_mp3=seg_mp3,
                    base_url=config.minimax_base_url,
                    api_key=config.minimax_api_key,
                    model=config.minimax_tts_model,
                    timeout=config.minimax_timeout_seconds,
                    speed=config.minimax_tts_speed,
                )
            except MiniMaxTTSError as error:
                logger.warning("stage=tts segment=%d minimax failed: %s; falling back to edge-tts",
                               i, error)
                warnings.append(f"segment {i}: minimax TTS failed ({error}); edge-tts fallback")
                fallback_used = True
                tts_duration_ms = None
        if tts_duration_ms is None:
            # Either MiniMax isn't configured, the user gave an explicit
            # voice without fallback, or MiniMax failed; fall back to edge-tts.
            edge_voice = choice.edge_fallback or "zh-CN-YunjianNeural"
            if not fallback_used:
                warnings.append(f"tts: edge-tts fallback engaged (voice={edge_voice})")
            fallback_used = True
            try:
                logger.debug("stage=tts segment=%d edge-tts voice=%s", i, edge_voice)
                edge_tts_synthesize_sync(
                    text=text_to_speak,
                    voice=edge_voice,
                    out_mp3=seg_mp3,
                    edge_tts_bin=config.edge_tts_bin,
                    rate="+50%",
                    timeout=30.0,
                )
            except EdgeTTSError as error:
                logger.exception("stage=tts segment=%d edge-tts fallback failed", i)
                raise PipelineError(f"edge-tts fallback failed on segment {i}: {error}") from error
        tts_segments.append(
            TTSSegment(
                text=text_to_speak,
                audio_path=str(seg_mp3),
                original_start=seg.start,
                original_end=seg.end,
                tts_duration_ms=tts_duration_ms,
            )
        )
        logger.debug("stage=tts segment=%d done mp3=%s", i, seg_mp3.name)
    timings["tts"] = int((time.monotonic() - t0) * 1000)
    logger.info("stage=tts done segs=%d fallback_used=%s",
                len(tts_segments), fallback_used)

    if not tts_segments:
        raise PipelineError("no segments produced TTS output; bailing out")

    voice_used = choice.minimax_id + (
        "+edge-fallback" if fallback_used else ""
    )

    # ---- Stage 6: align TTS to original timeline ----
    t0 = time.monotonic()
    aligned_wav = workspace / "voice-aligned.wav"
    logger.info("stage=align start tts_segments=%d total_dur=%.2fs", len(tts_segments), duration)
    align_segments_to_original(
        tts_segments,
        total_dur=duration,
        out_path=aligned_wav,
        ffmpeg_bin=config.ffmpeg_bin,
    )
    timings["align"] = int((time.monotonic() - t0) * 1000)
    logger.info("stage=align done wav=%s", aligned_wav)

    # ---- Stage 7: mix bed + aligned voice ----
    t0 = time.monotonic()
    bed_vol = MODE_BED_VOLUME.get(req.mode, 1.0)
    mixed_audio = workspace / "audio-mixed.wav"
    logger.info("stage=mix start bed_vol=%s voice_vol=%s", bed_vol, VOICE_VOLUME)
    _mix_bed_and_voice(
        bed.bed_path, aligned_wav, mixed_audio,
        config=config, bed_vol=bed_vol, voice_vol=VOICE_VOLUME,
    )
    timings["mix"] = int((time.monotonic() - t0) * 1000)
    logger.info("stage=mix done out=%s", mixed_audio)

    # ---- Stage 8: write ASS + mux ----
    t0 = time.monotonic()
    ass_path = workspace / "subtitles.ass"
    write_ass(ass_path, segments, target_language=req.target_language, use_translation=use_translation)
    timings["ass_write"] = int((time.monotonic() - t0) * 1000)
    logger.info("stage=ass_write done ass=%s", ass_path)

    if req.output_path:
        out_path = Path(req.output_path).expanduser().resolve()
    else:
        suffix = f"-mcp-{req.target_language}".replace("/", "-")
        out_path = src.with_name(f"{src.stem}{suffix}.mp4")

    t0 = time.monotonic()
    logger.info("stage=mux start in=video+ass+audio out=%s burn_subs=%s", out_path, req.burn_subtitles)
    try:
        if req.burn_subtitles:
            mux_with_ass(src, ass_path, mixed_audio, out_path, ffmpeg_bin=config.ffmpeg_bin)
        else:
            _mux_simple(src, mixed_audio, out_path, config=config)
    except Exception:
        logger.exception("stage=mux failed input=%s", out_path)
        raise
    timings["mux"] = int((time.monotonic() - t0) * 1000)
    logger.info("stage=mux done out=%s", out_path)

    # ---- Stage 9: loudness profile (per second across the output) ----
    t0 = time.monotonic()
    logger.info("stage=loudness start out=%s", out_path)
    rms = compute_per_second_rms(out_path, ffmpeg_bin=config.ffmpeg_bin, duration=duration)
    loudness = [
        LoudnessPoint(sec=int(i), mean_db=(round(v, 2) if not math.isnan(v) else -100.0))
        for i, v in enumerate(rms)
    ]
    timings["loudness"] = int((time.monotonic() - t0) * 1000)
    logger.info("stage=loudness done points=%d", len(loudness))

    bed_minus = compute_bed_minus_voice_db(
        bed.vocals_path, bed.bed_path, config=config,
    )

    result = DubResult(
        output_path=str(out_path),
        transcript=segments,
        model_used=req.model,
        voice_used=voice_used,
        timings_ms=timings,
        loudness_per_sec_db=loudness,
        bed_minus_voice_db=bed_minus,
        job_id=job.job_id,
        warnings=warnings,
    )
    logger.info("dub_video done job_id=%s out=%s timings_ms=%s", job.job_id, out_path, timings)
    return result


def transcribe_audio(
    req: TranscribeRequest,
    *,
    config: Config,
    job: Job,
) -> TranscribeResult:
    """Lower-level: just ASR. Returns segments + detected language."""
    logger = setup_logging(job_log_path=job.log_path)
    logger.info("transcribe job_id=%s audio=%s lang=%s", job.job_id, req.audio_path, req.language)

    src = Path(req.audio_path).expanduser().resolve()
    canonical_wav = job.workspace / "audio.wav"
    extract_canonical_audio(src, canonical_wav, ffmpeg_bin=config.ffmpeg_bin)

    try:
        resp = whisperx_transcribe(
            str(canonical_wav),
            language=req.language,
            base_url=config.whisperx_url,
        )
    except WhisperXBusy as error:
        raise PipelineError(f"whisperx busy: {error}") from error
    except WhisperXError as error:
        raise PipelineError(f"whisperx failed: {error}") from error

    segments: list[Segment] = []
    for sd in resp.get("segments", []):
        words = [
            WordTiming(
                text=str(w.get("text") or w.get("word") or ""),
                start=float(w.get("start", 0.0)),
                end=float(w.get("end", 0.0)),
                score=(float(w["score"]) if w.get("score") is not None else None),
            )
            for w in sd.get("words", [])
        ]
        segments.append(
            Segment(
                text=str(sd.get("text", "")).strip(),
                start=float(sd.get("start", 0.0)),
                end=float(sd.get("end", 0.0)),
                words=words,
            )
        )

    return TranscribeResult(
        language=resp.get("language"),
        segments=segments,
        job_id=job.job_id,
    )


def separate_audio(
    req: SeparateRequest,
    *,
    config: Config,
    job: Job,
) -> SeparateResult:
    """Lower-level: only run demucs and return stems (no mux)."""
    logger = setup_logging(job_log_path=job.log_path)
    logger.info("separate job_id=%s audio=%s model=%s", job.job_id, req.audio_path, req.model)

    src = Path(req.audio_path).expanduser().resolve()
    canonical_wav = job.workspace / "audio.wav"
    extract_canonical_audio(src, canonical_wav, ffmpeg_bin=config.ffmpeg_bin)

    sep_dir = job.workspace / "demucs"
    try:
        vocals, no_vocals = demucs_separate(
            str(canonical_wav),
            model=req.model,
            out_dir=sep_dir,
            demucs_bin=config.demucs_bin,
        )
    except DemucsError as error:
        raise PipelineError(f"demucs failed: {error}") from error

    return SeparateResult(
        vocals_path=str(vocals),
        no_vocals_path=str(no_vocals),
        model=req.model,
        job_id=job.job_id,
    )

