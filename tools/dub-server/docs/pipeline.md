# `pipeline.py` — The 9-stage Orchestrator

`tools/dub-server/dub_server/pipeline.py` is the **business logic layer**. Its
docstring makes the role explicit:

> Each public function in this module is the **library** form of one MCP tool.
> The FastMCP server (`server.py`) is a thin wrapper around these: validate
> input → grab JOB_LOCK → call the pipeline function → convert to JSON.

So:

```
┌──────────────────┐         ┌──────────────────────────┐         ┌────────────────┐
│  Claude Code /    │  stdio  │  server.py (FastMCP)      │  in-proc│  pipeline.py   │
│  Codex / cron    │ ──────▶ │  schema check + JOB_LOCK  │ ──────▶ │  9-stage编排    │
│  mcp__hypit-dub__*│         │  Config/Job 注入 + JSON   │         │  后端调用      │
└──────────────────┘         └──────────────────────────┘         └────────────────┘
                                                                              │
                                                                       ┌──────┴───────┐
                                                                       │  backends/   │
                                                                       │  whisperx /  │
                                                                       │  demucs /    │
                                                                       │  MiniMax /   │
                                                                       │  edge-tts /  │
                                                                       │  ffmpeg      │
                                                                       └──────────────┘
```

`__main__.py` invokes the same functions directly (CLI mode). The MCP wrapper
and the CLI wrapper share **zero business logic** — both are thin shells.

---

## Three public entry points

Each function takes `(*, config: Config, job: Job)` as keyword-only injection —
the caller (server.py's `_state()` or `__main__.py`) is responsible for building
`Config.from_env()` and `JobRegistry.create()`'s `Job`. The pipeline only
orchestrates and writes per-stage timings onto the job.

| Function | Lines | MCP tool | Input | Output |
|---|---|---|---|---|
| `dub_video(req, *, config, job)` | 717–1003 | `mcp__hypit-dub__dub_video` | `DubRequest` | `DubResult` |
| `transcribe_audio(req, *, config, job)` | 1006–1055 | `mcp__hypit-dub__transcribe_audio` | `TranscribeRequest` | `TranscribeResult` |
| `separate_audio(req, *, config, job)` | 1058–1088 | `mcp__hypit-dub__separate_audio` | `SeparateRequest` | `SeparateResult` |

`PipelineError` (line 92) is for recoverable orchestration failures (empty
transcript, whisperx busy, edge-tts total failure, etc.). Backend exceptions
(`FFmpegError`, `WhisperXError`, `MiniMaxTTSError`, `EdgeTTSError`,
`MiniMaxChatError`, `DemucsError`) are re-raised unchanged.

---

## `dub_video` — the 9 stages

`dub_video` is one linear script. It sets up the workspace under
`job.workspace`, then walks 9 stages, each wrapped in `time.monotonic()` so
timings land in `timings_ms`:

| # | Stage | Lines | What it does | Backend call |
|---|---|---|---|---|
| **1** | **probe + extract** | 743–751 | `ffprobe` for duration, `ffmpeg` to extract canonical 16 kHz mono WAV | `backends.probe` / `backends.extract_canonical_audio` |
| **2** | **prepare bed** | 754–759 | Choose `stereo-mix` (raw audio as bed), `phase-cancel` (L-R subtraction + 8× boost), or `ml-separate` (demucs) | `prepare_bed` → `_phase_cancel_bed` / `demucs_separate` |
| **3** | **whisperx ASR** | 762–794 | Transcribe; assemble `WordTiming` (from `words[]`) and `Segment` (from `segments[]`) | `backends.whisperx_transcribe` |
| **3b** | **long-segment splitter + reindex** | 799–809 | whisperx "small" often emits 20s+ mega-segments. Split on CJK punctuation / enumeration markers (`一、` ~ `十、`); then reindex word timings so each sub-segment carries only the words inside its window | `_split_long_segments` / `_reindex_word_timings` |
| **4** | **translate** | 811–860 | **One segment per chat call** to bypass MiniMax's hard ~600–700 char output cap. Then `_retry_incomplete_translations` re-asks with stricter prompt any translation that ends mid-clause or echoes source-script characters | `backends.translate_segments` / `_retry_incomplete_translations` |
| **5** | **TTS** | 863–929 | `resolve_voice` maps `"auto"` / `"zh-male"` / `male_zh_3` → MiniMax voice_id + edge fallback. MiniMax fails or key missing → edge-tts. Fallback is logged into `warnings` | `backends.minimax_tts_synthesize` / `backends.edge_tts_synthesize_sync` |
| **6** | **align** | 940–947 | Time-stretch each TTS clip to its original slot and place it on the timeline as `voice-aligned.wav` | `backends.align_segments_to_original` |
| **7** | **mix** | 950–957 | `_mix_bed_and_voice`: bed volume per mode (0.30 / 8.0 / 1.0), voice fixed 1.20×. `amix` + `alimiter` + 48 kHz resample | `_mix_bed_and_voice` |
| **8** | **ASS write + mux** | 961–976 | `write_ass` writes CJK + Latin subtitles (`_wrap_for_ass` hard-breaks both, with separate per-script char budgets: 14 CJK / 40 Latin), then `mux_with_ass` (burn) or `_mux_simple` (no burn) | `write_ass` / `backends.mux_with_ass` / `_mux_simple` |
| **9** | **loudness profile** | 979–985 | Per-second RMS → dB in `DubResult.loudness_per_sec_db`. Plus `compute_bed_minus_voice_db` to estimate bed isolation (ml-separate only) | `backends.compute_per_second_rms` / `compute_bed_minus_voice_db` |

`DubResult` packages everything:

```
output_path / transcript / model_used / voice_used /
timings_ms / loudness_per_sec_db / bed_minus_voice_db /
job_id / warnings
```

`server.py` calls `result.model_dump(mode="json")` to flatten `Path` /
`datetime` into JSON-safe types before handing to FastMCP.

---

## Voice resolution — `resolve_voice()` (lines 108–149)

```python
def resolve_voice(voice_input, target_language, *, minimax_voices) -> VoiceChoice
```

Maps the public `voice` field to `(minimax_id, edge_fallback)`:

| `voice_input` | Result |
|---|---|
| `"auto"` | Defaults to `<lang>-male`, e.g. `"auto:zh-male"`. MiniMax id from `minimax_voices` (env-derived), edge fallback from `EDGE_VOICE_FALLBACK` |
| `"zh-male"` / `"zh-female"` / `"en-male"` / `"en-female"` | Same lookup, label = key verbatim |
| Anything else (e.g. `"male_zh_3"`) | Treated as **explicit MiniMax voice_id**, `edge_fallback = None` — no TTS fallback if MiniMax fails |

`minimax_voices` comes from `Config.minimax_tts_voice_zh_male` etc. (env-
overridable). When the env doesn't supply a value, `backends.DEFAULT_VOICES`
fills in the gap.

---

## Bed preparation — `prepare_bed()` (lines 186–209) + `_phase_cancel_bed()` (157–175)

```python
def prepare_bed(canonical_wav, workspace, *, mode, model, config) -> BedArtefact
```

Three modes, picked by `DubRequest.mode`:

- **`stereo-mix`** (cheap, lowest quality): bed = the original WAV, voice ducks under it at 0.30×
- **`phase-cancel`** (cheap, OK quality): `pan=stereo|c0=c0-c1|c1=c1-c0` cancels center-panned vocals, `volume=8.0` restores lost energy; bed volume 8.0×
- **`ml-separate`** (expensive, best quality): demucs splits vocals/no_vocals; bed = no_vocals (already clean). Bed is **ducked to 0.30×** so the new voice at 1.20× sits ~12 dB above it. (Used to be 1.0×, which left the BGM competing with the new voice; reverted after the 2026-09-26 gz-exbi.mp4 dub showed audible overlap.)

`MODE_BED_VOLUME` (lines 75–79) and `VOICE_VOLUME = 1.20` (line 80) are tuned
against the working dub-video pipeline (see `examples/ranking-football/`'s
`out-zh.mp4` / `-chear` / `-ML` comparison files — these are the reference
outputs that fixed the constants).

`_phase_cancel_bed` is a single ffmpeg subprocess with a 600s timeout.

---

## Bed + voice mix — `_mix_bed_and_voice()` (lines 217–250)

```python
ffmpeg -i <bed> -i <voice> \
  -filter_complex "[0:a]volume={bed_vol}[bed];[1:a]volume={voice_vol}[vox];\
                   [bed][vox]amix=inputs=2:duration=longest:normalize=0,\
                   alimiter=limit=0.95,aresample=48000,aformat=channel_layouts=stereo[aout]" \
  -map "[aout]" -c:a pcm_s16le -ac 2 -ar 48000 <dst>
```

- `amix=inputs=2:duration=longest:normalize=0` — both tracks mix to the
  longer of the two
- `alimiter=limit=0.95` — hard ceiling so the final mix can't clip past 0.95
- `aresample=48000` + `aformat=channel_layouts=stereo` — final format
  standardised for the mux stage

---

## ASS subtitle writer — `write_ass()` + helpers (lines 286–396)

`write_ass(ass_path, segments, *, target_language, use_translation)` writes a
720×1280 V4+ ASS file with a single `Default` style:

```
Style: Default,Noto Sans CJK SC,32,&H00FFFFFF,&H000000FF,
       &H001D1D1D,&H00000000,1,0,0,0,100,100,0,0,1,2,1,2,40,40,80,1
```

Dialogue lines prefer `segment.translation` if `use_translation=True`, else
`segment.text`. Time stamps formatted as `H:MM:SS.cc` via `_format_ass_time`.

`_wrap_for_ass(text, *, max_chars)` is called with a per-script `max_chars`:

- **CJK text** (`max_chars=14`): hard-wrap at 14 chars; if a CJK
  punctuation is near the midpoint, split there. `_has_cjk` heuristic
  counts CJK code points to pick the script.
- **Latin text** (`max_chars=40`): word-wrap on spaces, capping each
  line at 40 chars (`_wrap_latin_on_word`). ffmpeg 6.x's `ass=` filter
  does not respect `WrapStyle: 2` reliably, so deferring to libass
  produces lines that spill off the right edge of a 720×1280 burn area
  (regression observed on the 2026-09-26 gz-exbi.mp4 dub — fixed by
  hard-wrapping in the pipeline instead of trusting libass).

Lines that exceed the per-script budget wrap with `\N` so the bottom
margin layout doesn't truncate them. Both branches recurse, so a
multi-line English sentence gets split into 2-4 hard-broken lines.

---

## Translation completeness — `_is_incomplete_translation` + `_retry_incomplete_translations` (lines 410–505)

The MiniMax chat endpoint occasionally "gives up" — output ends mid-clause,
or echoes source-script characters as a fallback. Detection:

1. **Empty after stripping** → `reason="empty"`
2. **No terminal punctuation** after stripping closing quotes/brackets → `reason="missing terminal punctuation"`
3. **CJK fallback characters in translation** (covers CJK Unified + extensions A-F + Hiragana/Katakana/Kana) → `reason="CJK fallback characters"`

Retry: build a stricter system prompt that explicitly forbids echoing
source-script characters and requires complete sentences. Re-call
`translate_segments` for **only** the flagged segments, one at a time. Up to
`max_attempts = 2` rounds; if a segment still fails after that, keep the
best-effort translation with a warning logged.

The retry uses `pipeline.translate_segments` directly (not the one-segment-
per-call pattern), passing through `config.minimax_*` parameters.

---

## Long-segment splitter — `_split_long_segments` + helpers (lines 544–656)

Whisperx "small" often emits mega-segments spanning many sentences. These:

- Overrun MiniMax chat output tokens and get truncated
- Produce 20+ second subtitles that are unwatchable
- Make the LLM translation lose focus

Splitting rules:

- **CJK** (`zh`, `ja`, `ko`): split on `。！？!?；;,，、` and enumeration
  markers (`一、` ... `十、`). Merge adjacent tiny pieces (< `min_chars`)
- **Latin**: split only on comma/colon runs as a soft fallback
- **Hard fallback**: if no internal cuts available and the segment is
  twice as long as the limit, split in half

Output is a new list of `Segment` with the same word timings; call
`_reindex_word_timings` afterwards to keep only the words inside each
sub-segment's window.

---

## Other helpers worth knowing

- **`_format_ass_time(seconds)`** (286–296): `H:MM:SS.cc` for ASS Dialogue
- **`_has_cjk(text)`** (363–366): counts CJK code points, returns
  `cjk > 0`. Used by `_wrap_for_ass` to decide hard-wrap vs libass wrap
- **`_phase_cancel_bed(src, dst, *, ffmpeg_bin, boost=8.0)`** (157–175):
  L-R subtraction with boost compensation
- **`_mix_bed_and_voice(bed, voice, dst, *, config, bed_vol, voice_vol)`**
  (217–250): the ffmpeg amix invocation
- **`_mux_simple(video, audio, dst, *, config)`** (253–278): video-copy +
  audio-re-encode mux when `burn_subtitles=False` (skip the ass= filter)
- **`compute_bed_minus_voice_db(vocals_path, bed_path, *, config)`** (684–709):
  bed-vs-voice isolation in dB. Only meaningful for `ml-separate` mode —
  for `stereo-mix` / `phase-cancel` the vocals reference doesn't exist
- **`_mean(values)`** (513–517): averages, skipping NaN. Used by
  `compute_bed_minus_voice_db`

---

## Calling convention (template)

Any script that wants to reuse the pipeline without going through MCP / CLI:

```python
from dub_server.config import Config
from dub_server.jobs import JobRegistry
from dub_server.pipeline import dub_video, PipelineError
from dub_server.schemas import DubRequest

config = Config.from_env()                       # from /opt/hypit/.env
registry = JobRegistry(config.job_root)
registry.sweep()
job = registry.create()                          # workspace + log path

req = DubRequest(
    source_video_path="/path/to/in.mp4",
    source_language="en",                         # or None for auto-detect
    target_language="zh-CN",
    voice="auto",                                 # or "zh-male" / explicit MiniMax id
    mode="stereo-mix",                            # or "phase-cancel" / "ml-separate"
    model="htdemucs_ft",                          # demucs model, ml-separate only
    burn_subtitles=True,
    output_path="/path/to/out.mp4",               # None → auto: in-<target>.mp4
)
try:
    result = dub_video(req, config=config, job=job)
    print(result.output_path, result.timings_ms, result.warnings)
except PipelineError as e:
    registry.fail(job.job_id, str(e))
    raise
```

## Worth-remembering internals

- **JOB_LOCK is in `jobs.py`, not in pipeline.py.** `pipeline.py` never
  locks anything; the wrapper (server.py) is responsible for serialisation.
  This is a deliberate split — pipeline is testable without any global lock.
- **`timings_ms` is stable.** Same stages, same keys, every run. UI / regression
  tests can rely on the shape.
- **`MODE_BED_VOLUME` / `VOICE_VOLUME` / `EDGE_VOICE_FALLBACK` are tuned.** Changing
  them affects intelligibility across all outputs. Reference: `examples/ranking-football/`
  `out-zh.mp4` / `-chear` / `-ML` / `-zh`.
- **Stage 5 has explicit two-layer fallback** (MiniMax → edge-tts). Even with no
  `MINIMAX_API_KEY`, as long as `edge-tts` is on `PATH`, zh/en output still
  works — just gets a `"tts: edge-tts fallback engaged"` warning in
  `DubResult.warnings`.
- **Stage 8 ASS is hardcoded to 720×1280** (lines 326–327). `FontSize=32` is
  sized for that resolution; on a 1920×1080 source the subtitles will look
  small. Current implementation does not scale ASS to source resolution —
  this is a known limitation, not in pipeline's scope to fix.
- **`use_translation=False` when `target_lang == source_lang`** (lines 858–860).
  `dub_video` skips Stage 4 entirely; `tts_segments` are spoken from the
  original `segment.text`.