# `config.py` — Environment Configuration

`tools/dub-server/dub_server/config.py` is **122 lines** of dataclass + env-var
loader. It does one job:

> Read every relevant env var into a frozen, typed `Config` snapshot that the
> pipeline uses as its dependency-injection bag.

It doesn't know what `dub_video` does. It doesn't know about whisperx, ffmpeg,
or TTS. It only knows that "this env var maps to this field".

---

## The `Config` dataclass (lines 30–54)

```python
@dataclass(frozen=True, slots=True)
class Config:
    # MiniMax direct API (per /opt/hypit/.env — mirror exactly)
    minimax_base_url: str = "https://api.minimaxi.com"
    minimax_api_key: str | None = None
    minimax_default_model: str = "image-01"      # not used for TTS, but matches .env
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
```

Three design choices worth remembering:

1. **`frozen=True, slots=True`** — immutable after construction, compact
   memory layout. Frozen also implicitly adds slots, but the explicit
   declaration documents intent.
2. **Every field has a working default** — even with no env vars, the
   server can start. The MiniMax key being `None` will fail downstream
   translation / TTS stages with a clear "requires MINIMAX_API_KEY" error.
3. **Defaults mirror `/opt/hypit/.env`** — these aren't arbitrary
   placeholders. The hardcoded values match what `bin/start-mcp.sh`
   actually loads. Including the MiniMax base URL `https://api.minimaxi.com`
   (direct, no Kapon gateway — see project memory).

---

## Field groups

| Group | Fields | Notes |
|---|---|---|
| **MiniMax chat** | `minimax_base_url`, `minimax_api_key`, `minimax_default_model`, `minimax_chat_model`, `minimax_timeout_seconds` | Direct API at `api.minimaxi.com` (or `api.minimax.cn`), Bearer `MINIMAX_API_KEY` |
| **MiniMax TTS** | `minimax_tts_model`, `minimax_tts_speed`, four `minimax_tts_voice_xx_xx` fields | `.env`'s `MINIMAX_TTS_*` block; voice IDs from official system voice catalog |
| **WhisperX** | `whisperx_url` | Local Python stdlib `http.server` on port 8765 |
| **System binaries** | `ffmpeg_bin`, `ffprobe_bin`, `demucs_bin`, `edge_tts_bin` | `$PATH` by default; override via env when on macOS or using a custom venv |
| **Job control** | `job_root`, `max_concurrent_dubs` | `JOB_ROOT` defaults to `/tmp/hypit-dub-server`; cleared on reboot; `MAX_CONCURRENT_DUBS` is a hint — actual serialisation comes from `JOB_LOCK` |

---

## `from_env()` — the only env-var reader (lines 56–101)

```python
@classmethod
def from_env(cls, environ: Mapping[str, str] | None = None) -> "Config":
    env = os.environ if environ is None else environ
    api_key_raw = env.get("MINIMAX_API_KEY")
    return cls(
        minimax_base_url=env.get("MINIMAX_BASE_URL", "https://api.minimaxi.com").strip(),
        minimax_api_key=api_key_raw.strip() if api_key_raw and api_key_raw.strip() else None,
        ...
    )
```

Four patterns worth knowing:

### 1. Blank-string → `None`

```python
minimax_api_key=api_key_raw.strip() if api_key_raw and api_key_raw.strip() else None
```

An env var set to `""` or `" "` is treated the same as unset. Downstream
code checks `if config.minimax_api_key is None` and falls into the right
fallback path.

### 2. Numeric fields go through helpers

```python
minimax_timeout_seconds=_positive_number(
    env.get("MINIMAX_TIMEOUT_SECONDS", "60"),
    "MINIMAX_TIMEOUT_SECONDS",
),
```

`_positive_number` (lines 20–27) and `_positive_integer` (lines 9–17)
raise `ValueError` on parse failure or non-positive values. The result is
**no bad config ever reaching runtime** — fail-fast at startup.

### 3. `.strip() or default` to handle whitespace

```python
minimax_chat_model=env.get("MINIMAX_CHAT_MODEL", "MiniMax-Text-01").strip() or "MiniMax-Text-01"
```

`or` after `.strip()` defends against `MINIMAX_CHAT_MODEL=" "` — falls
back to the default rather than passing whitespace into MiniMax requests.

### 4. Injectable env mapping

```python
def from_env(cls, environ: Mapping[str, str] | None = None) -> "Config":
    env = os.environ if environ is None else environ
```

The `environ` parameter is a **test hook**. Unit tests pass an explicit
dict instead of mutating `os.environ`:

```python
config = Config.from_env({
    "MINIMAX_API_KEY": "test-key",
    "WHISPERX_URL": "http://test-host:8765",
})
```

Production callers (`server.py` / `__main__.py`) pass nothing → default
behaviour reads `os.environ`.

---

## `__repr__` with key masking (lines 103–122)

```python
def __repr__(self) -> str:
    masked = "<unset>" if self.minimax_api_key is None else "***"
    return (
        f"Config(minimax_base_url={self.minimax_base_url!r}, "
        f"minimax_api_key={masked}, "
        ...
    )
```

The API key is always either `"<unset>"` or `"***"` — never the actual
value. This means `print(config)` / `logger.info("config=%s", config)` /
exception messages are safe to dump to stderr / logs without leaking
secrets.

---

## How `Config` flows through the system

```
                ┌──────────────────┐
                │  /opt/hypit/.env │
                │  source of truth │
                └─────────┬────────┘
                          │  loaded by bin/start-mcp.sh
                          ▼
                ┌──────────────────────┐
                │     os.environ       │
                └─────────┬────────────┘
                          │  Config.from_env()
                          ▼
                ┌──────────────────────┐
                │    Config (frozen)   │
                │  all env → fields    │
                └─────────┬────────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
        server.py     __main__.py    tests
              │           │
              │  passed as `config=` kwarg
              ▼           ▼
        ┌────────────────────────────┐
        │       pipeline.py          │
        │  dub_video(..., config,...)│
        └──────────┬─────────────────┘
                   │
                   ▼
        ┌────────────────────────────┐
        │   backends/*.py            │
        │  each takes only the       │
        │  fields it needs:          │
        │   base_url, api_key, *_bin │
        └────────────────────────────┘
```

Key property: **backends don't import `Config`**. They take individual
fields (`base_url`, `api_key`, `*_bin`) as function arguments. So:

- You can call a backend directly with hardcoded values (useful for tests)
- `Config` stays at the wrapper layer (server.py / __main__.py), not in
  the business layer
- Adding a new env var touches `Config` and one wrapper, not the pipeline

---

## Tuning via `.env`

`bin/start-mcp.sh` does `source /opt/hypit/.env` before exec'ing Python.
Most useful tunables:

```bash
# Required
MINIMAX_API_KEY=...

# Optional — override defaults
MINIMAX_BASE_URL=https://api.minimaxi.com        # default; or api.minimax.cn
MINIMAX_TIMEOUT_SECONDS=60
MINIMAX_TTS_MODEL=speech-02-hd
MINIMAX_TTS_SPEED=1.1
MINIMAX_TTS_VOICE_ZH_MALE=Chinese (Mandarin)_Male_Announcer
MINIMAX_TTS_VOICE_ZH_FEMALE=Chinese (Mandarin)_Warm_Bestie
MINIMAX_TTS_VOICE_EN_MALE=English_Trustworth_Man
MINIMAX_TTS_VOICE_EN_FEMALE=English_CalmWoman

# Service endpoints
WHISPERX_URL=http://127.0.0.1:8765

# System binaries (only needed if not on $PATH)
FFMPEG_BIN=ffmpeg
FFPROBE_BIN=ffprobe
DEMUCS_BIN=demucs
EDGE_TTS_BIN=edge-tts

# Job control
JOB_ROOT=/tmp/hypit-dub-server
MAX_CONCURRENT_DUBS=1
```

---

## When to extend

If you need to add a new tunable:

1. Add a field to `Config` (with a sensible default that matches `.env`)
2. Add a line to `from_env()` that reads + validates the env var
3. Thread the field through `pipeline.py` to the relevant backend call

No other file needs to know about env vars. The architecture enforces
"env vars enter only via `Config.from_env()`".