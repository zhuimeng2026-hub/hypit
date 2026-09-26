from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import os
from typing import Mapping


def _positive_integer(value: str, name: str, maximum: int | None = None) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if parsed <= 0 or (maximum is not None and parsed > maximum):
        suffix = f" no greater than {maximum}" if maximum is not None else ""
        raise ValueError(f"{name} must be positive{suffix}")
    return parsed


def _positive_number(value: str, name: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise ValueError(f"{name} must be a number") from error
    if parsed <= 0:
        raise ValueError(f"{name} must be positive")
    return parsed


@dataclass(frozen=True, slots=True)
class Config:
    # MiniMax direct API (per /opt/hypit/.env — mirror exactly)
    minimax_base_url: str = "https://api.minimaxi.com"
    minimax_api_key: str | None = None
    minimax_default_model: str = "image-01"  # not used for TTS, but matches .env
    minimax_chat_model: str = "MiniMax-Text-01"
    minimax_timeout_seconds: float = 60.0
    # MiniMax TTS — see /opt/hypit/.env for voice_id source URL
    minimax_tts_model: str = "speech-02-hd"
    minimax_tts_speed: float = 1.1
    minimax_tts_voice_zh_male: str = "Chinese (Mandarin)_Male_Announcer"
    minimax_tts_voice_zh_female: str = "Chinese (Mandarin)_Warm_Bestie"
    minimax_tts_voice_en_male: str = "English_Trustworth_Man"
    minimax_tts_voice_en_female: str = "English_CalmWoman"
    # WhisperX service
    whisperx_url: str = "http://127.0.0.1:8765"
    # System binaries
    ffmpeg_bin: str = "ffmpeg"
    ffprobe_bin: str = "ffprobe"
    demucs_bin: str = "demucs"
    edge_tts_bin: str = "edge-tts"
    # Job control
    job_root: Path = field(default_factory=lambda: Path("/tmp/hypit-dub-server"))
    max_concurrent_dubs: int = 1

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if environ is None else environ
        api_key_raw = env.get("MINIMAX_API_KEY")
        return cls(
            minimax_base_url=env.get("MINIMAX_BASE_URL", "https://api.minimaxi.com").strip(),
            minimax_api_key=api_key_raw.strip() if api_key_raw and api_key_raw.strip() else None,
            minimax_default_model=env.get("MINIMAX_DEFAULT_MODEL", "image-01").strip() or "image-01",
            minimax_chat_model=env.get("MINIMAX_CHAT_MODEL", "MiniMax-Text-01").strip() or "MiniMax-Text-01",
            minimax_timeout_seconds=_positive_number(
                env.get("MINIMAX_TIMEOUT_SECONDS", "60"),
                "MINIMAX_TIMEOUT_SECONDS",
            ),
            # MiniMax TTS: env-overridable voice_ids (defaults match /opt/hypit/.env).
            minimax_tts_model=env.get("MINIMAX_TTS_MODEL", "speech-02-hd").strip() or "speech-02-hd",
            minimax_tts_speed=_positive_number(
                env.get("MINIMAX_TTS_SPEED", "1.1"),
                "MINIMAX_TTS_SPEED",
            ),
            minimax_tts_voice_zh_male=(
                env.get("MINIMAX_TTS_VOICE_ZH_MALE", "Chinese (Mandarin)_Male_Announcer").strip()
                or "Chinese (Mandarin)_Male_Announcer"
            ),
            minimax_tts_voice_zh_female=(
                env.get("MINIMAX_TTS_VOICE_ZH_FEMALE", "Chinese (Mandarin)_Warm_Bestie").strip()
                or "Chinese (Mandarin)_Warm_Bestie"
            ),
            minimax_tts_voice_en_male=(
                env.get("MINIMAX_TTS_VOICE_EN_MALE", "English_Trustworth_Man").strip()
                or "English_Trustworth_Man"
            ),
            minimax_tts_voice_en_female=(
                env.get("MINIMAX_TTS_VOICE_EN_FEMALE", "English_CalmWoman").strip()
                or "English_CalmWoman"
            ),
            whisperx_url=env.get("WHISPERX_URL", "http://127.0.0.1:8765").strip() or "http://127.0.0.1:8765",
            ffmpeg_bin=env.get("FFMPEG_BIN", "ffmpeg").strip() or "ffmpeg",
            ffprobe_bin=env.get("FFPROBE_BIN", "ffprobe").strip() or "ffprobe",
            demucs_bin=env.get("DEMUCS_BIN", "demucs").strip() or "demucs",
            edge_tts_bin=env.get("EDGE_TTS_BIN", "edge-tts").strip() or "edge-tts",
            job_root=Path(env.get("JOB_ROOT", "/tmp/hypit-dub-server")).expanduser(),
            max_concurrent_dubs=_positive_integer(
                env.get("MAX_CONCURRENT_DUBS", "1"),
                "MAX_CONCURRENT_DUBS",
            ),
        )

    def __repr__(self) -> str:
        masked = "<unset>" if self.minimax_api_key is None else "***"
        return (
            f"Config(minimax_base_url={self.minimax_base_url!r}, "
            f"minimax_api_key={masked}, "
            f"minimax_default_model={self.minimax_default_model!r}, "
            f"minimax_chat_model={self.minimax_chat_model!r}, "
            f"minimax_timeout_seconds={self.minimax_timeout_seconds}, "
            f"minimax_tts_model={self.minimax_tts_model!r}, "
            f"minimax_tts_speed={self.minimax_tts_speed}, "
            f"minimax_tts_voice_zh_male={self.minimax_tts_voice_zh_male!r}, "
            f"minimax_tts_voice_zh_female={self.minimax_tts_voice_zh_female!r}, "
            f"minimax_tts_voice_en_male={self.minimax_tts_voice_en_male!r}, "
            f"minimax_tts_voice_en_female={self.minimax_tts_voice_en_female!r}, "
            f"whisperx_url={self.whisperx_url!r}, "
            f"ffmpeg_bin={self.ffmpeg_bin!r}, ffprobe_bin={self.ffprobe_bin!r}, "
            f"demucs_bin={self.demucs_bin!r}, edge_tts_bin={self.edge_tts_bin!r}, "
            f"job_root={str(self.job_root)!r}, "
            f"max_concurrent_dubs={self.max_concurrent_dubs})"
        )