# `schemas.py` — Pydantic Contracts

`tools/dub-server/dub_server/schemas.py` is **84 lines** of pure Pydantic
model definitions. No business logic, no IO, no side effects. Its purpose:

> Lock down the wire format between MCP / CLI and the pipeline. Anything
> caller-supplied is strict (reject extras). Anything pipeline-supplied is
> permissive (forward-compatible with backend evolution).

---

## Top-level inventory

| Type | Category | Strictness | Purpose |
|---|---|---|---|
| `WordTiming` | Internal data | `extra="allow"` | whisperx word-level timestamp |
| `Segment` | Internal data | `extra="allow"` | One transcript / subtitle segment with words + translation |
| `LoudnessPoint` | Output data | `extra="allow"` | One second of mean RMS in dB |
| `DubMode` | `Literal` | — | Bed mode trio |
| `SeparationModel` | `Literal` | — | demucs model pair |
| `DubRequest` / `DubResult` | Tool IO | forbid / allow | `dub_video` in / out |
| `SeparateRequest` / `SeparateResult` | Tool IO | forbid / allow | `separate_audio` in / out |
| `TranscribeRequest` / `TranscribeResult` | Tool IO | forbid / allow | `transcribe_audio` in / out |

---

## The three `extra` policies

### `extra="forbid"` — input side (the three `*Request` models)

```python
class DubRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_video_path: str
    ...
```

**Effect**: when the caller passes a key that's not in the schema,
Pydantic raises `ValidationError` instead of silently dropping it.

**Why**: LLMs are creative. They will pass `tts_provider: "elevenlabs"`
or `output_format: "mov"` thinking they're being helpful. `forbid` makes
those attempts **loud failures** rather than silent ignores, so the model
learns the correct schema from the error message.

### `extra="allow"` — output side + internal data (everything else)

```python
class Segment(BaseModel):
    model_config = ConfigDict(extra="allow")
    text: str; start: float; end: float
    words: list[WordTiming] = Field(default_factory=list)
    translation: Optional[str] = None
```

**Effect**: unknown keys pass through and round-trip on `model_dump()`.

**Why**: whisperx returns segments with `id`, `seek`, `tokens`,
`temperature`, `compression_ratio`, `no_speech_prob`, and a dozen more
fields. We only need 4, but **keeping the extras is useful for debug** —
the full transcript round-trips through MCP, and a user inspecting
`transcript[0]` sees the same metadata they'd see from a raw whisperx
call.

### Side-by-side

| Dimension | `*Request` (forbid) | `*Result` / `Segment` (allow) |
|---|---|---|
| Who fills fields | LLM / shell / cron (external) | pipeline itself (internal) |
| Unknown fields | **Rejected** — fail loudly | **Preserved** — debug-friendly |
| Strictness goal | Contract first | Evolution first |

---

## Internal models

### `WordTiming` (lines 8–13)

```python
class WordTiming(BaseModel):
    text: str
    start: float       # seconds
    end: float         # seconds
    score: Optional[float] = None
```

`text` may come from whisperx's `text` or `word` key — `pipeline.py` line
779 handles both with `w.get("text") or w.get("word") or ""`. `score` is
whisperx's word-level confidence (0–1), may be `None`.

### `Segment` (lines 16–22)

```python
class Segment(BaseModel):
    text: str
    start: float        # seconds
    end: float          # seconds
    words: list[WordTiming] = Field(default_factory=list)
    translation: Optional[str] = None
```

- `start` / `end` are **seconds (float)**, not centiseconds.
- `translation` defaults to `None`. Same-language dubs (`en → en`)
  skip translation; `pipeline.py` uses `seg.text` instead of `seg.translation`
  when `use_translation=False`.
- `extra="allow"` lets whisperx's bonus fields (`id`, `seek`, etc.) flow
  through untouched. `_retry_incomplete_translations` uses
  `seg.model_copy(update={"translation": ...})` to swap only `translation`
  without disturbing the rest.

### `LoudnessPoint` (lines 25–28)

```python
class LoudnessPoint(BaseModel):
    sec: int
    mean_db: float
```

- One per second, `sec` starts at 0.
- `mean_db` may be -100 (silence floor) or NaN-coerced; pipeline clamps
  NaN → -100.0 before storage.

---

## Literal types

```python
DubMode = Literal["stereo-mix", "ml-separate", "phase-cancel"]
SeparationModel = Literal["htdemucs", "htdemucs_ft"]
```

Both reused across `DubRequest.mode`, `DubRequest.model`, `SeparateRequest.model`.
Why Literal over Enum:

- **JSON-friendly**: `"ml-separate"` round-trips naturally over MCP / CLI
  (no need for `.value` lookups)
- **No runtime methods needed**: never iterated, never named
- **Single source of truth**: changing the set updates every usage

`__main__.py` argparse uses the same string tuple:

```python
dub.add_argument("--mode", default="ml-separate",
                 choices=("stereo-mix", "ml-separate", "phase-cancel"))
```

— schema and CLI both validate against the same literal set.

---

## Tool IO models

### `DubRequest` (lines 35–44) — the most important schema

```python
class DubRequest(BaseModel):
    source_video_path: str
    source_language: Optional[str] = None    # None → whisperx auto-detect
    target_language: str = "zh-CN"
    voice: str = "auto"                      # "auto" | explicit MiniMax voice_id
    mode: DubMode = "ml-separate"
    model: SeparationModel = "htdemucs"
    burn_subtitles: bool = True
    output_path: Optional[str] = None
```

| Field | Default rationale |
|---|---|
| `source_language=None` | Most callers let whisperx auto-detect |
| `target_language="zh-CN"` | Pipeline's primary use case is en→zh |
| `voice="auto"` | Caller doesn't need to know voice IDs; `pipeline.resolve_voice` does the lookup |
| `mode="ml-separate"` | Cleanest bed, but expensive. Default = best quality |
| `model="htdemucs"` | Default demucs. `htdemucs_ft` is opt-in for higher quality |
| `burn_subtitles=True` | Subtitles are part of the deliverable |
| `output_path=None` | Pipeline auto-generates `<src>-<target>.mp4` |

LLM-friendly defaults: most callers only need `source_video_path` and
`target_language`. Everything else has a sensible default.

### `DubResult` (lines 47–57)

```python
class DubResult(BaseModel):
    output_path: str
    transcript: list[Segment]
    model_used: str
    voice_used: str                  # "minimax_id" or "minimax_id+edge-fallback"
    timings_ms: dict[str, int]
    loudness_per_sec_db: list[LoudnessPoint]
    bed_minus_voice_db: Optional[float] = None   # ml-separate only
    job_id: str
    warnings: list[str] = Field(default_factory=list)
```

Includes:

- **Per-stage timings** — UI / regression tests can graph this
- **Voice used** — `voice_used` ends in `+edge-fallback` when edge-tts
  was triggered (see pipeline.py lines 934–936)
- **Quality metric** — `bed_minus_voice_db` is the bed-vs-voice isolation
  in dB. Only meaningful for `ml-separate`; `None` for other modes
- **Warnings list** — non-fatal issues (fallbacks, partial retries)

### `SeparateRequest` / `SeparateResult` (lines 60–71)

```python
class SeparateRequest(BaseModel):
    audio_path: str
    model: SeparationModel = "htdemucs"

class SeparateResult(BaseModel):
    vocals_path: str
    no_vocals_path: str
    model: str
    job_id: str
```

Minimal: just demucs in, two stems + job_id out.

### `TranscribeRequest` / `TranscribeResult` (lines 74–83)

```python
class TranscribeRequest(BaseModel):
    audio_path: str
    language: Optional[str] = None

class TranscribeResult(BaseModel):
    language: Optional[str] = None
    segments: list[Segment]
    job_id: str
```

`language=None` → whisperx auto-detects. Whatever it picks round-trips
into `TranscribeResult.language` — caller can always read the detected
language from the result.

---

## Pydantic patterns in use

### `model_dump(mode="json")` for the JSON boundary

`server.py` and `__main__.py` both call `result.model_dump(mode="json")`:

- `mode="json"` flattens `Path` → `str`, `datetime` → ISO string,
  `timedelta` → seconds, `Enum` → `.value`
- Default `model_dump()` returns native Python types — `datetime` stays,
  which breaks `json.dumps`

This is the one place Pydantic is asked to bridge to a non-Pydantic world
(JSON-RPC, shell). Inside `pipeline.py`, models stay as-is and pass
between functions without dumping.

### `Field(default_factory=list)` — never `= []`

```python
words: list[WordTiming] = Field(default_factory=list)
warnings: list[str] = Field(default_factory=list)
```

Mutable defaults are a classic Python trap. Pydantic doesn't auto-copy
mutable defaults like `dataclasses` does, so `Field(default_factory=...)`
is the safe pattern.

### No `strict=True`

All fields use ordinary Python types (`str`, `float`, `bool`, `Literal`),
so Pydantic does implicit coercion (`"0.5"` → `0.5`, `"true"` → `True`).
This is forgiving for LLM callers, but means type confusion is hidden.
Accepted trade-off; not changed in current implementation.

---

## How schemas fit into the layers

```
              LLM / shell
                  │  JSON / argparse
                  ▼
    ┌─────────────────────────────┐
    │   schemas.DubRequest        │   ← Pydantic validates; extra="forbid"
    │   schemas.DubResult         │     rejects unknown LLM fields
    └─────────────┬───────────────┘
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
   server.py          __main__.py
   (mcp tool)         (argparse + print)
        │                   │
        └─────────┬─────────┘
                  ▼
    ┌─────────────────────────────┐
    │   pipeline.dub_video()      │
    │   uses Segment, WordTiming, │   ← internal data, extra="allow"
    │   LoudnessPoint internally  │     forward-compatible
    └─────────────────────────────┘
```

The schemas are the **translation layer** between three worlds:

- **External** (LLM / shell) sees only the strict `*Request` / `*Result` shapes
- **Internal** (pipeline ↔ backends) sees only `Segment` / `WordTiming` /
  `LoudnessPoint` / `TTSSegment`
- **Wrapper** (server / CLI) calls `model_dump(mode="json")` at the JSON
  boundary to flatten Pydantic types

The whole design philosophy in one sentence:

> **`forbid` for what callers send us; `allow` for what we send back.**