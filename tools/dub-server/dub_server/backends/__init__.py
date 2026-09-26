"""Backend adapters for the dub-server pipeline.

Each backend is a leaf node with no upward dependencies: it accepts raw values
and returns raw values (paths, dicts, primitives). Domain-specific exceptions
are raised on failure; the pipeline layer handles retry/fallback policy.

Re-exports are kept flat so callers can write:

    from dub_server.backends import probe, transcribe, synthesize
"""
from .align import TTSSegment, align_segments_to_original
from .demucs import DemucsError, separate as demucs_separate
from .edge_tts import (
    EdgeTTSError,
    synthesize as edge_tts_synthesize,
    synthesize_sync as edge_tts_synthesize_sync,
)
from .ffmpeg import (
    FFmpegError,
    compute_per_second_rms,
    extract_canonical_audio,
    mux_with_ass,
    probe,
)
from .minimax_llm import MiniMaxChatError, translate_segments
from .minimax_tts import DEFAULT_VOICES, MiniMaxTTSError, synthesize as minimax_tts_synthesize
from .whisperx import (
    WhisperXBusy,
    WhisperXError,
    transcribe as whisperx_transcribe,
)

__all__ = [
    # ffmpeg
    "FFmpegError",
    "compute_per_second_rms",
    "extract_canonical_audio",
    "mux_with_ass",
    "probe",
    # whisperx
    "WhisperXBusy",
    "WhisperXError",
    "whisperx_transcribe",
    # demucs
    "DemucsError",
    "demucs_separate",
    # edge-tts
    "EdgeTTSError",
    "edge_tts_synthesize",
    "edge_tts_synthesize_sync",
    # MiniMax TTS
    "DEFAULT_VOICES",
    "MiniMaxTTSError",
    "minimax_tts_synthesize",
    # MiniMax LLM
    "MiniMaxChatError",
    "translate_segments",
    # align
    "TTSSegment",
    "align_segments_to_original",
]