from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class WordTiming(BaseModel):
    model_config = ConfigDict(extra="allow")
    text: str
    start: float
    end: float
    score: Optional[float] = None


class Segment(BaseModel):
    model_config = ConfigDict(extra="allow")
    text: str
    start: float
    end: float
    words: list[WordTiming] = Field(default_factory=list)
    translation: Optional[str] = None


class LoudnessPoint(BaseModel):
    model_config = ConfigDict(extra="allow")
    sec: int
    mean_db: float


DubMode = Literal["stereo-mix", "ml-separate", "phase-cancel"]
SeparationModel = Literal["htdemucs", "htdemucs_ft"]


class DubRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_video_path: str
    source_language: Optional[str] = None  # None → whisperx auto-detects
    target_language: str = "zh-CN"
    voice: str = "auto"  # "auto" | explicit TTS voice id
    mode: DubMode = "ml-separate"
    model: SeparationModel = "htdemucs"
    burn_subtitles: bool = True
    output_path: Optional[str] = None


class DubResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    output_path: str
    transcript: list[Segment]
    model_used: str
    voice_used: str
    timings_ms: dict[str, int]
    loudness_per_sec_db: list[LoudnessPoint]
    bed_minus_voice_db: Optional[float] = None
    job_id: str
    warnings: list[str] = Field(default_factory=list)


class SeparateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    audio_path: str
    model: SeparationModel = "htdemucs"


class SeparateResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    vocals_path: str
    no_vocals_path: str
    model: str
    job_id: str


class TranscribeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    audio_path: str
    language: Optional[str] = None


class TranscribeResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    language: Optional[str] = None
    segments: list[Segment]
    job_id: str