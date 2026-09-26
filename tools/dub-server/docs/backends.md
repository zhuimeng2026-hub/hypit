# `backends/` — Leaf Adapters

`tools/dub-server/dub_server/backends/` is the bottom layer of the dub-server
stack. Its `__init__.py` docstring states the contract:

> Each backend is a leaf node with no upward dependencies: it accepts raw values
> and returns raw values (paths, dicts, primitives). Domain-specific exceptions
> are raised on failure; the pipeline layer handles retry/fallback policy.

Eight files, ~1000 lines total:

| File | Role | Backend type |
|---|---|---|
| `ffmpeg.py` | probe / extract / mux / per-second RMS | subprocess |
| `whisperx.py` | ASR over HTTP | HTTP |
| `demucs.py` | vocal separation | subprocess |
| `edge_tts.py` | fallback TTS | subprocess (async + sync) |
| `minimax_tts.py` | primary TTS | HTTP |
| `minimax_llm.py` | batch translation | HTTP |
| `prompts.py` | translation prompt templates | — (no IO) |
| `align.py` | TTS → timeline alignment | ffmpeg filter_complex |

---

## Architecture

```
                          pipeline.py
                            │ orchestration + fallback policy
              ┌─────────────┼─────────────┬───────────────┐
              ▼             ▼             ▼               ▼
       backends/ffmpeg.py backends/whisperx.py backends/demucs.py  backends/align.py
              │             │             │               │
       subprocess        requests      subprocess       subprocess
              │             │             │               │
              ▼             ▼             ▼               ▼
        ffmpeg binary   whisperx HTTP  demucs binary  ffmpeg binary
        on $PATH        127.0.0.1:8765 on $PATH        (filter_complex)
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        minimax_tts.py  minimax_llm.py  edge_tts.py
              │             │             │
              ▼             ▼             ▼
        api.minimaxi.com api.minimaxi.com edge-tts CLI
        /v1/t2a_v2       /v1/chat/completions (Microsoft voices)
```

Every backend exposes a flat namespace via `backends/__init__.py`:

```python
from dub_server.backends import (
    probe, extract_canonical_audio, mux_with_ass, compute_per_second_rms,
    whisperx_transcribe, demucs_separate,
    minimax_tts_synthesize, translate_segments,
    edge_tts_synthesize, edge_tts_synthesize_sync,
    align_segments_to_original,
    TTSSegment, DEFAULT_VOICES,
    FFmpegError, WhisperXError, WhisperXBusy, DemucsError,
    EdgeTTSError, MiniMaxTTSError, MiniMaxChatError,
)
```

---

## Operating principles (apply to every backend)

1. **Stateless pure functions** — no module-level caches, no connection
   pools. Tests can run them concurrently without interference.
2. **One exception type per backend** — `FFmpegError`, `WhisperXError`,
   `WhisperXBusy`, `DemucsError`, `EdgeTTSError`, `MiniMaxTTSError`,
   `MiniMaxChatError`, plus `RuntimeError` for `align`. `WhisperXBusy`
   is a subclass of `WhisperXError` so `except WhisperXError` catches both.
3. **Injectable paths / URLs** — `ffmpeg_bin`, `demucs_bin`, `edge_tts_bin`,
   `base_url`, `api_key` are all function arguments. Backends never read
   `os.environ`. `Config` is the only env reader.
4. **subprocess over import** for `demucs` and `edge_tts` — keeps model
   lifecycle out of import time, lets timeouts truly cancel.
5. **`requests` over SDK** for HTTP backends — synchronous, simple, no
   async machinery to manage.
6. **stderr tail on failure** — every subprocess backend captures the
   last 1000 chars of stderr and embeds them in the exception message.
7. **No business logic** — backends don't know about job lifecycle, the
   9-stage pipeline, or fallback chains. They just call out and report
   success / failure.

---

## Per-file deep dives

### `ffmpeg.py` — heaviest local subprocess wrapper (~244 lines)

Five public functions:

| Function | Purpose |
|---|---|
| `probe(path)` | `ffprobe -v error -print_format json -show_format -show_streams`. Returns parsed dict. |
| `extract_canonical_audio(src, dst)` | Convert any input to **16 kHz mono PCM s16le WAV** — the format whisperx requires (per `/opt/hypit/services/whisperx/src/hypit_whisperx_service/audio.py`). |
| `mux_with_ass(video, ass, audio, dst)` | Burn ASS subtitles into video, mux with new audio. H.264 `libx264 -preset medium -crf 20 -pix_fmt yuv420p` + AAC 128k for max compatibility. |
| `compute_per_second_rms(path, *, duration)` | One ffmpeg invocation per whole-second window with `volumedetect`. Parse `mean_volume:` from stderr. NaN-tolerant; -100 dB floor. |

`_run(cmd, *, timeout, label)` is the shared subprocess wrapper:

```python
try:
    completed = subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)
except subprocess.TimeoutExpired as error:
    raise FFmpegError(f"{label} timed out after {timeout}s: cmd={cmd!r}") from error
if completed.returncode != 0:
    stderr_tail = completed.stderr.decode("utf-8", "replace")[-1000:]
    raise FFmpegError(f"{label} failed (rc={completed.returncode}): stderr={stderr_tail}")
```

`mux_with_ass` notes: ffmpeg 6.x's `ass=` filter dropped `force_style`.
All styling must live in the `.ass` file's `Style:` header — which is
what `pipeline.write_ass` writes.

---

### `whisperx.py` — single-endpoint HTTP client (101 lines)

```python
response = requests.post(f"{base_url}/transcribe", json={"audio_path": str(wav_path), "language": ...})
```

| Class | Purpose |
|---|---|
| `WhisperXError` | Any non-success response or malformed payload |
| `WhisperXBusy(WhisperXError)` | Specifically 503 BUSY — another caller holds whisperx's inference lock |

The busy distinction matters: `pipeline.dub_video` rephrases
`WhisperXBusy` as "whisperx busy: ..." (suggests retry later), other
errors as "whisperx failed: ..." (suggests permanent problem).

**File location constraint**: `wav_path` must live under
`HYPIT_WHISPERX_INPUT_ROOTS` (default `/tmp`). The pipeline stages the
file under `job.workspace` = `/tmp/hypit-dub-server/<job_id>/` which
satisfies this. Changing `JOB_ROOT` requires syncing whisperx's env.

**Backward-compat response normalisation** (lines 90–94):

```python
if "segments" not in body and "words" in body:
    body = {"language": body.get("language"),
            "segments": [{"text": "", "words": body["words"]}]}
```

Older whisperx versions put aligned words at the top level instead of
inside `segments[]`. This shim normalises both shapes to the canonical
form.

---

### `demucs.py` — subprocess wrapper around the demucs CLI (137 lines)

```python
demucs -n <model> --two-stems vocals --device cpu -o <out_dir> <audio_path>
```

Returns `(vocals_path, no_vocals_path)`.

Why subprocess over Python API (docstring):

> The shipped CLI handles model download + cache uniformly across machines,
> and the in-process API's lazy model loading would tie demucs lifetime to
> importing this module. Subprocess isolation also lets the pipeline layer
> cancel work cleanly via timeout.

`_locate_track_dir(out_dir_path)` solves demucs's **layout drift** between
versions:

- Old: `<out_dir>/<basename>/{vocals,no_vocals}.wav`
- New: `<out_dir>/<model>/<basename>/{vocals,no_vocals}.wav`

Instead of hard-coding, it scans 1–2 levels deep for a directory containing
both stems. Newest by mtime wins.

---

### `edge_tts.py` — async + sync (93 lines)

```python
async def synthesize(text, voice, out_mp3, *, rate="+50%", ...) -> Path
def synthesize_sync(text, voice, out_mp3, **kwargs) -> Path:
    return asyncio.run(synthesize(text, voice, out_mp3, **kwargs))
```

`pipeline.dub_video` calls `synthesize_sync` (line 910) because the whole
pipeline is synchronous. The async form is for future callers that want
`asyncio.gather` over many TTS calls.

`rate="+50%"` is set by the pipeline to compensate for edge-tts's
default slow Chinese / English voices.

---

### `minimax_tts.py` — direct MiniMax `/v1/t2a_v2` client (144 lines)

```python
url = f"{base_url}/v1/t2a_v2"
payload = {
    "model": "speech-02-hd",
    "text": text,
    "stream": False,
    "output_format": "hex",                       # ← key choice, see below
    "voice_setting": {"voice_id": voice_id, "speed": speed, "vol": 1.0, "pitch": 0},
    "audio_setting": {"format": "mp3", "sample_rate": 32000, "bitrate": 128000},
}
response = requests.post(url, json=payload, headers={"Authorization": f"Bearer {api_key}"}, timeout=timeout)
audio_bytes = bytes.fromhex(body["data"]["audio"])
```

**Why `output_format="hex"`** (docstring): avoids a second HTTP hop to
fetch a signed URL. Single POST returns the audio inline as a hex
string. `bytes.fromhex` decodes it; we write the file directly.

**Strict response validation** — four explicit checks, each with its own
error message:

1. `base_resp.status_code != 0` → MiniMax business error
2. `data.audio` missing or empty → empty payload
3. `bytes.fromhex` fails → malformed hex
4. `extra_info.audio_length` parsed as int → ms duration for align

`audio_length_ms` flows into `TTSSegment.tts_duration_ms` — when present,
`align._segment_tts_duration` uses it instead of ffprobe'ing every
segment file.

`DEFAULT_VOICES` (lines 29–34) is the fallback for the 4 `minimax_tts_voice_xx_xx`
fields in `Config`. Voice IDs are pinned from the official MiniMax
system voice catalog (`https://platform.minimax.io/docs/faq/system-voice-id`).

---

### `minimax_llm.py` — MiniMax chat translation (228 lines)

```python
url = f"{base_url}/v1/chat/completions"
payload = {
    "model": "MiniMax-Text-01",
    "messages": [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_message},
    ],
    "max_tokens": 4096,
    "temperature": 0.1,
}
```

**Note on `max_tokens`**: even setting 4096 doesn't help. MiniMax chat
silently caps output at ~600–700 characters per response. The pipeline
works around this by **calling once per segment** (lines 830–839):

```python
for i, chunk in enumerate([segments[i:i + 1] for i in range(len(segments))]):
    out = translate_segments(chunk, ...)
```

Backend still supports batch (its `_parse_numbered_lines` is built for
multi-segment responses); pipeline's choice of 1-segment batches is
empirical.

**`max_tokens=4096` is kept** as a defensive ceiling — without it, some
endpoints apply a server-side cap that drops the last few sentences
mid-word.

**`_parse_numbered_lines`** (lines 54–73) accepts `"1."` / `"1)"` /
`"1、"` prefix variants. MiniMax occasionally switches style; first
match wins to handle echoes.

**No input mutation** (lines 207–226): output segments are copies with
`translation` set. Tries `model_copy` (Pydantic path) first; falls back
to `copy.copy` for plain dataclass / namespace inputs. Backend doesn't
import `dub_server.schemas` to avoid the cycle.

---

### `prompts.py` — translation prompt templates (46 lines)

```python
SYSTEM_PROMPT = """\
You are a translator for video dubbing. Translate each numbered input into {target_language}.
...
CRITICAL RULES — without these the output gets truncated and unusable:
- Translate EVERY input line completely. Do not stop early...
- Never paste Chinese / source-language characters...
- Each numbered input, even if very long, must translate to a complete readable sentence...
"""

USER_PROMPT_TEMPLATE = """\
{lines}

Reply format: one translation per line in the target language, prefixed by the same number...
"""

def build_user_message(segments): ...
def build_system_message(target_language): ...
```

Two-layer prompt defense:

1. **`SYSTEM_PROMPT` is the primary** — sent on every call by
   `minimax_llm.translate_segments`.
2. **`pipeline._retry_incomplete_translations.strict_system`** is the
   secondary, used only when the primary output looks incomplete
   (no terminal punctuation, or CJK fallback characters detected).
   Hardcoded inside `pipeline.py`, not in `prompts.py` — could be
   factored out later.

Why separate file: prompt content is product policy (register, rules),
not IO. Splitting keeps `prompts.py` swappable without touching
backend logic.

---

### `align.py` — single-ffmpeg filter_complex alignment (224 lines)

The cleverest backend. Uses **one** ffmpeg invocation to align N TTS
clips to the original timeline:

```python
# Per segment:
filter_lines.append(
    f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,"
    + ",".join(atempo_chain)                       # atempo=2.0,atempo=1.5,...
    + f",adelay={delay_ms}|{delay_ms}:all=1,volume=1.4[v{i}]"
)
inputs.extend(["-i", str(seg.audio_path)])

# Final mix:
mix_line = (
    f"{all_v_streams}amix=inputs={N}:duration=longest:normalize=0,"
    f"apad=whole_dur={total_dur:.3f},"             # pad to original video length
    f"aresample=48000,aformat=channel_layouts=stereo[out]"
)

cmd = [
    ffmpeg_bin, "-y", *inputs,                    # N inputs in one ffmpeg
    "-filter_complex", filter_complex,
    "-map", "[out]", "-c:a", "pcm_s16le", "-ac", "2", "-ar", "48000", out_p,
]
```

`_atempo_chain(ratio)` decomposes any ratio >2 or <0.5 into chained
`atempo=2.0` / `atempo=0.5` calls, since ffmpeg's atempo only accepts
the 0.5..2.0 range:

```python
while r > 2.0:
    chain.append("atempo=2.0"); r /= 2.0
while r < 0.5:
    chain.append("atempo=0.5"); r *= 2.0
chain.append(f"atempo={r:.4f}")
```

`TTSSegment` dataclass (lines 33–52) carries `(text, audio_path,
original_start, original_end, tts_duration_ms)`. `text` is kept for
logging only — the aligner doesn't read it.

`volume=1.4` per track is intentional — the downstream alimiter in
`pipeline._mix_bed_and_voice` normalises it. Pumping to 1.4 keeps each
voice segment loud enough to survive the bed+voice mix.

**Why single-call**: N segments × N subprocesses = N process starts.
Single ffmpeg with N inputs does all alignment in one process. Empirically
~8s → ~1.5s on 12 segments / 60s video.

`_segment_tts_duration(seg)` reads `seg.tts_duration_ms` if set
(MiniMax path), otherwise ffprobes `seg.audio_path` (edge-tts path).
JSON's `format.duration` is tried first, then stderr parsing as
fallback.

---

## Failure modes — exception type → typical cause

| Exception | Source | Pipeline handling |
|---|---|---|
| `FFmpegError` | ffmpeg / ffprobe non-zero exit, timeout, bad JSON | Bubbles up to `pipeline.dub_video` → `PipelineError` → server returns `{"error": "pipeline"}` |
| `WhisperXBusy` | 503 BUSY (someone else holds whisperx) | `pipeline.dub_video` rewords as "whisperx busy: ..." — caller may retry |
| `WhisperXError` | any other non-2xx | Bubbles up |
| `DemucsError` | demucs non-zero exit, missing stems | Bubbles up |
| `EdgeTTSError` | edge-tts non-zero exit, timeout | Bubbles up — pipeline catches specifically in fallback path |
| `MiniMaxTTSError` | MiniMax TTS non-2xx, missing audio, malformed hex | Pipeline catches; falls back to edge-tts; logs warning |
| `MiniMaxChatError` | MiniMax chat non-2xx, missing translations | Pipeline catches; translation stage fails → `PipelineError` |
| `RuntimeError` (align) | filter_complex construction or ffmpeg fail | Bubbles up |

The pipeline doesn't blanket-catch — it knows each backend's exception
type and routes appropriately.

---

## Cross-cutting patterns worth remembering

### Subprocess invocation — `_run(cmd, *, timeout, label)`

```python
try:
    completed = subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)
except subprocess.TimeoutExpired as error:
    raise FFmpegError(f"{label} timed out after {timeout}s: cmd={cmd!r}") from error
if completed.returncode != 0:
    stderr_tail = completed.stderr.decode("utf-8", "replace")[-1000:]
    raise FFmpegError(f"{label} failed (rc={completed.returncode}): stderr={stderr_tail}")
```

Used by `ffmpeg.py`, `demucs.py`. Always:

- `capture_output=True` (no console pollution)
- `check=False` (let the backend raise its own typed error)
- `timeout=` (no hung subprocesses)
- stderr tail at 1000 chars

### HTTP error handling — strict shape validation

`minimax_tts.py` and `minimax_llm.py` both walk the response shape with
explicit guards:

```python
if not response.ok:
    raise BackendError(f"...status={response.status_code}: body={response.text[:500]!r}")

body = response.json()                            # may raise ValueError
if not isinstance(body, dict):
    raise BackendError("...non-object body")

base_resp = body.get("base_resp")
if isinstance(base_resp, dict) and base_resp.get("status_code", 0) != 0:
    raise BackendError("...status_code != 0")

# Then domain-specific checks...
```

Each guard has its own error message so debugging points to the exact
step that failed.

### Injectable paths and credentials

No backend reads `os.environ`. Every external dependency is a function
argument:

```python
def transcribe(wav_path, language, *, base_url, timeout): ...
def separate(audio_path, *, model, out_dir, demucs_bin, timeout): ...
def synthesize(text, voice_id, out_mp3, *, base_url, api_key, model, timeout, speed): ...
def translate_segments(segments, target_language, *, base_url, api_key, model, timeout, source_language): ...
```

`Config` is the only place env vars enter; wrappers (`server.py` /
`__main__.py`) build `Config` once and pass `base_url` / `api_key` /
`*_bin` to each backend call.

---

## Adding a new backend

To plug in (say) ElevenLabs TTS as a third fallback after MiniMax and
edge-tts:

1. Create `dub_server/backends/elevenlabs_tts.py` with a `synthesize()`
   function matching the contract: takes raw inputs, returns `(Path, ms)`,
   raises `ElevenLabsError` on failure
2. Add `ElevenLabsError` + re-export in `backends/__init__.py`
3. Add `elevenlabs_api_key` field to `Config` with `from_env()` mapping
4. Wire it into `pipeline.dub_video` Stage 5 — try MiniMax first, then
   edge-tts, then ElevenLabs; each fallback chain in the same try/except
   block as current logic
5. Add `ElevenLabsError` to the `pipeline.py` import block

No other file in the codebase needs to change. The layered architecture
keeps blast radius small.