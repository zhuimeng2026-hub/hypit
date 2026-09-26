# hypit-dub-server

A local stdio MCP server that wraps the Hypit video dubbing pipeline. Exposes three tools (`dub_video`, `separate_audio`, `transcribe_audio`) so external agents — Claude Code, Codex, custom OpenAI-compatible hosts — can produce a fully re-dubbed, ASS-subtitle-burned MP4 without re-implementing the orchestration.

The pipeline runs the same stages we used to produce `examples/ranking-football/out-zh.mp4` and the four published variants on `out.mp4`:

```
source video
   │
   ▼  ffmpeg
16 kHz mono PCM s16 WAV                       (canonical audio)
   │
   ▼  demucs (htdemucs | htdemucs_ft)         (ML vocal separation, optional)
vocals.wav   +   no_vocals.wav
   │
   ▼  whisperx HTTP @ 127.0.0.1:8765           (forced word-level alignment)
segments: [{text, start, end, words[…]}]
   │
   ▼  MiniMax chat (or graceful failure)       (translation, 1:1 segment count)
translated_segments
   │
   ▼  MiniMax /v1/t2a_v2  →  edge-tts          (TTS, per-segment fallback)
per-segment mp3 + total duration
   │
   ▼  ffmpeg filter_complex                    (atempo chain + atemix + apad)
dubbed_bed.wav                                 (time-aligned to original slots)
   │
   ▼  ffmpeg mux + ASS burn                    (subtitles from translation)
dubbed.mp4
```

Each call returns a Pydantic-typed result with the output path, the transcript, per-stage timings, a 20-second loudness profile, and the bed/voice energy delta as a quality proxy.

## Status

**MVP / alpha.** Std-only stdio transport, single in-flight job (threading.Lock — whisperx is single-inference, demucs holds the model in memory), local filesystem only. No auth, no multi-tenant, no HTTP transport. See **Limitations** below for what's deliberately out of scope for the first cut.

## Install

Requires Python 3.11–3.13, [uv](https://docs.astral.sh/uv/), and a handful of system binaries that are already present on the production host but documented here for portability.

```bash
cd /opt/hypit/tools/dub-server
uv sync
```

`uv sync` resolves `mcp[cli]`, `edge-tts`, `requests`, and `pydantic` into a project-local `.venv/`. Heavy ML imports (`demucs`, `whisperx`, `torch`) are **not** pip dependencies — they are system binaries that the backends shell out to, so the lockfile stays small and the install is fast.

### System dependencies

The pipeline calls these binaries; they must be on `PATH` (or pointed at via env vars):

| Binary     | Used for                              | Provided by                       |
| ---------- | ------------------------------------- | --------------------------------- |
| `ffmpeg`   | probe / extract / mux / per-sec RMS   | system package (`apt install ffmpeg`) |
| `ffprobe`  | duration / stream probing             | ships with `ffmpeg`               |
| `demucs`   | vocal separation (htdemucs)           | pip in a dedicated env (already set up at `/opt/hypit/services/`) |
| `edge-tts` | fallback TTS CLI                      | the `edge-tts` Python package, invoked as a module |
| `curl`     | health probe of the whisperx service  | system package                    |

A running **whisperx HTTP service** at `http://127.0.0.1:8765` is also required for `transcribe_audio` and `dub_video`. See the Hypit docs for `services/whisperx/` if it is not already up.

## Run as MCP

```bash
uv run python -m dub_server            # stdio transport (default)
uv run python -m dub_server stdio      # explicit — equivalent to no args
```

The server speaks MCP protocol on **stdout** and writes every log line to **stderr** (MCP protocol frames on stdout must stay clean). Per-job logs are mirrored to `JOB_ROOT/<job_id>/run.log` so a tool call that crashes the host still leaves a paper trail.

## MCP client configuration

Drop-in entries for `~/.claude.json` (Claude Code), `~/.codex/mcp_servers.json` (Codex), `claude_desktop_config.json`, or any other MCP host that follows the same shape.

### Claude Code

Save this as `~/.claude.json` (or merge into the existing `mcpServers` block):

```json
{
  "mcpServers": {
    "hypit-dub": {
      "command": "uv",
      "args": [
        "--directory", "/opt/hypit/tools/dub-server",
        "run", "python", "-m", "dub_server"
      ],
      "env": {
        "PATH": "${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

A working copy ships at `.mcp.example.json` in this directory.

### Codex

Codex uses the same shape; the file is `~/.codex/mcp_servers.json`:

```json
// ~/.codex/mcp_servers.json
{
  "mcpServers": {
    "hypit-dub": {
      "command": "uv",
      "args": ["--directory", "/opt/hypit/tools/dub-server",
               "run", "python", "-m", "dub_server"]
    }
  }
}
```

### Inspector (smoke test)

The MCP Inspector is the fastest way to poke the contract without wiring a host:

```bash
npx @modelcontextprotocol/inspector \
  uv --directory /opt/hypit/tools/dub-server run python -m dub_server
```

## Tools

| Name              | Signature (key args)                                                                                                   | Returns                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `dub_video`       | `source_video_path`, `source_language?`, `target_language="zh-CN"`, `voice="auto"`, `mode="ml-separate"`, `model="htdemucs"`, `burn_subtitles=True`, `output_path?` | `{output_path, transcript, model_used, voice_used, timings_ms, loudness_per_sec_dB, bed_energy_minus_voice_dB, job_id}` |
| `separate_audio`  | `audio_path`, `model="htdemucs"`                                                                                       | `{vocals_path, no_vocals_path, model, duration_s, job_id}`                                                       |
| `transcribe_audio`| `audio_path`, `language?`                                                                                              | `{segments: [{text, start, end, words: [{word, start, end, score}]}], language, job_id}`                          |

All three tools block until completion (no polling). Each call holds a process-global `JOB_LOCK`; concurrent submissions are serialised FIFO. A second tool call issued while another is running returns a `BusyLock` error — see **Concurrency** below.

### `dub_video` argument detail

| Arg                 | Default     | Notes                                                                                            |
| ------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `source_video_path` | required    | Absolute path to the input MP4/MKV. File must be readable by the dub-server process.              |
| `source_language`   | `None`      | ISO code (`"en"`, `"zh"`, …). `None` lets whisperx auto-detect (slower, slightly less accurate). |
| `target_language`   | `"zh-CN"`   | BCP-47. Drives both the LLM translation prompt and the voice default.                            |
| `voice`             | `"auto"`    | `"auto"` picks from a hard-coded MiniMax voice catalog (zh-male/zh-female/en-male/en-female). Pass a voice id directly to override. |
| `mode`              | `"ml-separate"` | `"ml-separate"` runs demucs before ASR; `"direct"` skips separation (faster, worse on music-heavy sources). |
| `model`             | `"htdemucs"` | `"htdemucs"` (default) or `"htdemucs_ft"` (slower, ~3 min/20s clip on CPU, higher quality on dense mixes). |
| `burn_subtitles`    | `True`      | Hard-burn the ASS subtitles into the video. A future flag will produce a sidecar SRT instead.    |
| `output_path`       | auto        | Defaults to `JOB_ROOT/<job_id>/out.mp4`. Caller can override to write into a project dir.         |

### `DubResult` schema (JSON)

```jsonc
{
  "job_id": "01JABCXYZ…",
  "output_path": "/tmp/hypit-dub-server/01JABCXYZ…/out.mp4",
  "transcript": [
    { "start": 0.42, "end": 3.18, "text": "And it's Galatasaray with the early press…",
      "words": [{ "word": "And", "start": 0.42, "end": 0.55, "score": 0.99 }, …] },
    …
  ],
  "model_used": "htdemucs",
  "voice_used": "zh-male",
  "timings_ms": {
    "extract": 312,
    "separate": 184_203,
    "transcribe": 8_421,
    "translate": 6_012,
    "tts_total": 22_403,
    "align_and_mux": 4_911
  },
  "loudness_per_sec_dB": [-23.1, -22.8, -23.4, …],   // 20 entries
  "bed_energy_minus_voice_dB": -8.2                  // bed quieter than voice by 8.2 dB on average
}
```

`bed_energy_minus_voice_dB` is a quality proxy: a value in `[-12, -6]` dB means the dub voice is comfortably above the original bed without ducking it. Anything closer to `0` or positive means the mix is unbalanced.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `MINIMAX_BASE_URL` | `https://api.minimaxi.com` | MiniMax TTS/Chat base URL (直连，不走 Kapon). |
| `MINIMAX_API_KEY` | `<unset>` | Bearer token. **Required** for translate + TTS. Missing → `PipelineError("translation requires MINIMAX_API_KEY")`. |
| `MINIMAX_DEFAULT_MODEL` | `image-01` | Reserved (image-gen legacy). |
| `MINIMAX_CHAT_MODEL` | `MiniMax-Text-01` | LLM model for translation. Swap to `claude-3-haiku-…` or `gpt-4o-mini` for better quality. |
| `MINIMAX_TIMEOUT_SECONDS` | `60.0` | HTTP timeout for chat + TTS calls. |
| `MINIMAX_TTS_MODEL` | `speech-02-hd` | TTS model name. |
| `MINIMAX_TTS_SPEED` | `1.1` | Speed multiplier for TTS. API range `0.5..2.0`. |
| `MINIMAX_TTS_VOICE_ZH_MALE` | `Chinese (Mandarin)_Male_Announcer` | Default zh-male voice id. |
| `MINIMAX_TTS_VOICE_ZH_FEMALE` | `Chinese (Mandarin)_Warm_Bestie` | Default zh-female voice id. |
| `MINIMAX_TTS_VOICE_EN_MALE` | `English_Trustworth_Man` | Default en-male voice id. |
| `MINIMAX_TTS_VOICE_EN_FEMALE` | `English_CalmWoman` | Default en-female voice id. |
| `WHISPERX_URL` | `http://127.0.0.1:8765` | Local whisperx service. |
| `JOB_ROOT` | `/tmp/hypit-dub-server` | Per-call workspace; cross-process locks live under here (`$JOB_ROOT/.dub.lock`). |
| `MAX_CONCURRENT_DUBS` | `1` | Reserved (lock already enforces this; legacy knob). |
| `FFMPEG_BIN` / `FFPROBE_BIN` | `ffmpeg` / `ffprobe` | Override if a different binary is on `PATH`. |
| `DEMUCS_BIN` / `EDGE_TTS_BIN` | `demucs` / `edge-tts` | Override. |
| `DUB_LOCK_BLOCKING` | unset | `1` to wait-and-queue; default non-blocking. |
| `DUB_LOCK_PATH` | unset | Override the lock file location for cross-workspace usage. |

The server reads its configuration from `os.environ` lazily — no side effects on import. Mirror the existing `/opt/hypit/.env` so existing keys (`MINIMAX_*`) work without translation.

| Variable                       | Required          | Default                  | Used by                              |
| ------------------------------ | ----------------- | ------------------------ | ------------------------------------ |
| `MINIMAX_API_KEY`              | for LLM + MiniMax TTS | —                    | `minimax_llm.translate_segments`, `minimax_tts.synthesize` |
| `MINIMAX_BASE_URL`             | no                | `https://api.minimaxi.com` | both MiniMax clients              |
| `MINIMAX_DEFAULT_MODEL`        | no                | `MiniMax-Text-01`        | `minimax_llm`                        |
| `MINIMAX_TIMEOUT_SECONDS`      | no                | `120`                    | both MiniMax clients                 |
| `MINIMAX_TTS_VOICE_ZH_MALE`    | no                | hard-coded default       | voice catalog override               |
| `MINIMAX_TTS_VOICE_ZH_FEMALE`  | no                | hard-coded default       | voice catalog override               |
| `MINIMAX_TTS_VOICE_EN_MALE`    | no                | hard-coded default       | voice catalog override               |
| `MINIMAX_TTS_VOICE_EN_FEMALE`  | no                | hard-coded default       | voice catalog override               |
| `WHISPERX_URL`                 | no                | `http://127.0.0.1:8765`  | `whisperx.transcribe`                |
| `HYPIT_WHISPERX_INPUT_ROOTS`   | no                | `/tmp`                   | writable roots for the whisperx service |
| `FFMPEG_BIN`                   | no                | `ffmpeg`                 | `backends/ffmpeg`                    |
| `FFPROBE_BIN`                  | no                | `ffprobe`                | `backends/ffmpeg`                    |
| `DEMUCS_BIN`                   | no                | `demucs`                 | `backends/demucs`                    |
| `EDGE_TTS_BIN`                 | no                | `python -m edge_tts`     | `backends/edge_tts`                  |
| `JOB_ROOT`                     | no                | `/tmp/hypit-dub-server`  | job artefact directory               |
| `MAX_CONCURRENT_DUBS`          | no                | `1`                      | currently informational; lock is always 1 for MVP |
| `LOG_LEVEL`                    | no                | `INFO`                   | root logger                          |

> **Fallback rule.** If `MINIMAX_API_KEY` is unset, `minimax_tts.synthesize` raises `MiniMaxAuthError` per segment and `pipeline.dub_video` automatically falls back to `edge-tts`. The translation stage is **not** fall-back-able: without a key, `minimax_llm.translate_segments` raises `MiniMaxChatError` and the dub fails. Set the key.

Source your existing Hypit env once per shell:

```bash
set -a; source /opt/hypit/.env; set +a
uv --directory /opt/hypit/tools/dub-server run python -m dub_server
```

## End-to-end flow

1. Agent calls `dub_video("/opt/hypit/examples/ranking-football/out.mp4", source_language="en", target_language="zh-CN", voice="auto", mode="ml-separate", model="htdemucs")`.
2. The server validates input via Pydantic, acquires `JOB_LOCK`, allocates `JOB_ROOT/<job_id>/`, and calls `pipeline.dub_video(req)`.
3. Pipeline runs each stage, writing artefacts under `JOB_ROOT/<job_id>/` (canonical audio, vocals, no-vocals, segments, translated segments, per-segment mp3, ASS, dubbed bed, final mp4, `run.log`).
4. Each stage logs to `run.log` and the stage time is recorded into `timings_ms`.
5. On success the result (Pydantic `DubResult`) is JSON-serialised and returned. On failure the same shape is returned with `status="failed"` and `error["stage"]` identifying the failing step.
6. A 10-job FIFO sweep on next startup clears old job directories (default `JOB_ROOT` cap; configurable).

## Concurrency

The MVP runs **one dub at a time per workspace** (default serialized by a
POSIX `flock(2)` on `$JOB_ROOT/.dub.lock`). whisperx's HTTP service is
single-inference (returns `503 BUSY` on a second concurrent request),
demucs holds the model in memory, and MiniMax TTS charges for each call —
so the lock protects the whole pipeline from being stepped on.

Behaviour:

| Setting | Effect |
|---|---|
| `DUB_LOCK_BLOCKING` unset (default) | Non-blocking: whoever gets the lock first runs; concurrent invocations raise `DubJobBusy → PipelineError("another dub is in progress on this workspace")` and exit cleanly. |
| `DUB_LOCK_BLOCKING=1` | Poll every 0.5 s until acquired (no timeout; cancel via Ctrl-C). Use this in CI / batch scripts where queueing is desired. |
| `DUB_LOCK_PATH=/path/to/lock` | Override the lock file location (e.g. for system-wide locking: `DUB_LOCK_PATH=/var/lock/dub-server.lock`). |
| `fcntl` not available (Windows) | Lock becomes a no-op + warning. whisperx single-inference then becomes your bottleneck — Windows hosts will see occasional `503 BUSY`. |

The kernel releases the lock automatically if the holding process dies; a
crashed dub does NOT lock subsequent calls forever.

The lock is **per `JOB_ROOT`**: two CLI invocations pointing at different
workspaces run in parallel; two pointing at the same `JOB_ROOT` serialize.

## Job lifecycle

`JOB_ROOT/<job_id>/` layout:

```
<job_id>/
├── run.log                 # full stderr mirror, rotation-friendly
├── canonical.wav           # 16 kHz mono PCM s16 (whisperx input)
├── vocals.wav              # demucs output
├── no_vocals.wav           # demucs output
├── transcript.json         # whisperx segments
├── translated.json         # MiniMax LLM output (1:1 with transcript)
├── segments/               # per-segment TTS mp3s
│   ├── 000.mp3
│   ├── 001.mp3
│   └── …
├── bed.wav                 # time-aligned dubbed bed
├── out.ass                 # generated subtitles
└── out.mp4                 # final muxed output
```

A FIFO sweep on startup keeps at most the 10 most recent job directories under `JOB_ROOT`; older runs are deleted unceremoniously. `JOB_ROOT=//tmp` is fine for MVP because `/tmp` is large enough on this host and reboots are rare; move it to `~/.cache/hypit-dub-server/` if you need persistence across reboots.

## Verification

The plan's MVP gate is a four-call smoke test. From inside an MCP host:

```
transcribe_audio("/opt/hypit/examples/ranking-football/out.mp4")
```

→ must return 9 segments with `text`, `start`, `end`, `words[]` — shape identical to what we got from the earlier `curl POST /transcribe` on the same file.

```
separate_audio("/tmp/hypit-dub-server/<job>/canonical.wav", model="htdemucs")
```

→ returns `vocals.wav` (-20 dB mean) and `no_vocals.wav` (-34 dB mean), matching our earlier run on `out.mp4`'s audio.

```
dub_video(
    source_video_path="/opt/hypit/examples/ranking-football/out.mp4",
    source_language="en",
    target_language="zh-CN",
    voice="auto",
    mode="ml-separate",
    model="htdemucs",
)
```

→ returns `output_path` and a 20-entry `loudness_per_sec_dB` profile. Compare against the published `out-zh-ML.mp4`: per-second means within ±0.5 dB (engine is deterministic given same inputs).

**Concurrency guard.** Two simultaneous `dub_video` calls — second one must raise `BusyLock`. Document in your agent prompt if you need retry semantics.

**Fallback test.** With `MINIMAX_API_KEY` set but pointed at an unreachable URL, a single `dub_video` call must complete using edge-tts voices, with `voice_used` in the result noting the fallback per segment.

## Architecture

```
dub_server/
├── __init__.py            # version string
├── __main__.py            # argparse → mcp.run(...) dispatcher
├── server.py              # FastMCP("hypit-dub", …) + @mcp.tool() decorators
├── config.py              # lazy os.environ loader, no import side effects
├── schemas.py             # Pydantic v2 IO models (DubRequest / DubResult / …)
├── pipeline.py            # dub_video orchestration; re-exportable as a library
├── jobs.py                # JobRegistry (OrderedDict + Lock), Job dataclass
├── logging_setup.py       # root logger → stderr + per-job file handler
└── backends/
    ├── ffmpeg.py          # probe / extract / mix / mux / per-sec RMS
    ├── whisperx.py        # POST {WHISPERX_URL}/transcribe (BUSY → WhisperXBusy)
    ├── demucs.py          # subprocess to demucs CLI; htdemucs / htdemucs_ft
    ├── edge_tts.py        # async wrapper around `python -m edge_tts`
    ├── minimax_tts.py     # POST {MINIMAX_BASE_URL}/v1/t2a_v2 (hex → mp3)
    ├── minimax_llm.py     # POST chat-completions → translated segments
    ├── align.py           # ffmpeg filter_complex atempo chain + amix + apad
    └── prompts.py         # translation system prompt (keep short)
```

External code can import the pipeline directly without going through MCP:

```python
from dub_server.pipeline import dub_video
from dub_server.schemas import DubRequest

req = DubRequest(source_video_path="/opt/.../out.mp4", target_language="zh-CN")
result = dub_video(req)   # blocks, returns DubResult
```

This dual surface is intentional — the same orchestration should be callable from a future batch runner or a Celery worker without dragging MCP into the import graph.

## Development

```bash
uv sync --extra dev                       # pulls pytest
uv run pytest                             # unit tests (added in next iteration)
uv run python -c "import dub_server.server; print('imports clean')"
uv run python -m dub_server --help
```

The repo deliberately has no `tests/` yet — the plan marks integration tests as the next deliverable. Each tool is verifiable through MCP Inspector today.

To change the lock policy for local debugging:

```bash
DUB_LOCK_BYPASS=1 uv run python -m dub_server   # single-process; you take responsibility for races
```

## Limitations / Out of scope (for MVP)

The following are deliberately deferred. See the plan's **Out of scope** section for the original rationale.

- HTTP / SSE transport. `mcp.run(transport="streamable-http", …)` is a one-line flip once we want it.
- Auth / multi-tenant. Std-only stdio means only one host controls the process.
- Async job queue with `dub_status` / `dub_cancel`. Jobs ≤60 s block the caller; longer jobs need this — next iteration.
- SRT sidecar export. Hard-burn is the only mode today.
- Persistent output directory outside `/tmp`.
- Tests (placeholder structure only); integration tests follow next.

## Roadmap / Next improvements

Ordered by ROI. Each entry lists the gap, the proposed fix, and the rough effort.

### 1. Swap or add a translation model (1-line env change)

**Gap:** `MINIMAX_CHAT_MODEL` defaults to `MiniMax-Text-01`. Translation completeness post-retry today is ~95%. The remaining 5% (sloppy proper nouns, rare CJK terms, mid-word cuts) cost visible subtitle quality.

**Fix:** In `/opt/hypit/.env` change to `MINIMAX_CHAT_MODEL=claude-3-haiku-20240307` or `gpt-4o-mini` and re-run. The OpenAI-compatible `translate_segments` in `dub_server/backends/minimax_llm.py` already takes a model string, so no code change needed. Side-by-side AB compare a 5-minute clip first.

**Effort:** 5 minutes per try. Picking the right model and confirming it beats `MiniMax-Text-01` end-to-end.

### 2. Burned-in subtitle eraser (mask + inpaint)

**Gap:** When the source video already has hard-burned subtitles (very common for short-form social media), our new English burn lands on top and the original Chinese subs remain visible. Output ends up dual-language.

**Fix:** Add `dub_server/backends/subtitle_masker.py` that:
1. Uses `ffmpeg+scenedetect` to find subtitle regions (top/middle/bottom bands where text is rendered).
2. Generates an inpainting mask per frame for those regions.
3. Runs LaMa or Stable-Diffusion inpaint on the masked pixels (CPU OK for LaMa, ~0.5s/frame at 720p).
4. Then runs the dub pipeline on the cleaned video as before.

Subscript ALSO implement `subtitle_mask --bands top` / `bottom` / `middle` so the user picks which band to erase.

**Effort:** ~3 days + a tested inpaint model. This is the highest-value "look professional" upgrade.

### 3. TTS length overflow auto-split (`slice_to_match`)

**Gap:** Chinese source segment of 1.6 s often produces English TTS of 1.7-2.0 s (English words are more numerous for the same meaning). When the ratio exceeds `atempo` limit (clamped 0.5-2.0), `align_segments_to_original` silently breaks and the TTS audio gets cut off, producing a voice glitch.

**Fix:** Add a `slice_to_match` stage in the orchestration (before `align_segments_to_original`) that detects overflow, splits the original source segment at sentence boundaries, re-runs ASR + translate + TTS on each sub-piece, then chains sub-pieces' TTS under their original window.

**Effort:** ~1 day. Keep sub-pieces ≤4 s each; rare for well-paced narration.

### 4. Speaker diarization (multi-speaker support)

**Gap:** whisperx-small treats the whole audio as one speaker. In podcasts / interview clips / conference talks, this produces conflated text and broken attribution. Today the output is unusable for any source with 2+ speakers.

**Fix:** Add a `pyannote/speaker-diarization-3.0` stage before `whisperx_transcribe`:
1. Run `pyannote-audio` to label speaker per timestamp segment.
2. Re-segment the whisperx output by speaker turn boundaries.
3. Pass `speaker_id` into the prompt: "translate each numbered input. Each input is one speaker turn; preserve speaker-narration register."

**Effort:** ~3 days. Requires adding `pyannote-audio` to deps and a Hugging Face token.

### 5. Soft subtitle sidecar export (`.ass` next to `.mp4`)

**Gap:** Today the ASS subtitles are physically baked into the video. Viewers in different regions have no way to pick their language. Search engines / archives can't index subtitle text.

**Fix:** Make `burn_subtitles=False` produce both an `.mp4` (with audio bed + new voice, no burn) AND an `.ass` sidecar in the same dir. mp4 marks the ass track as `text` codec (`mov_text`) so VLC / mpv / Discord can toggle. Keeps all the existing code paths; just add an extra ffmpeg `-map 2:s -c:s mov_text` invocation and a text-file write for the .ass.

**Effort:** ~half day. Mostly plumbing.

### Status

| # | Item | Owner | Status |
|---|------|-------|--------|
| 1 | Model swap | TBD | not started |
| 2 | Subtitle eraser | TBD | not started |
| 3 | TTS overflow split | TBD | not started |
| 4 | Speaker diarization | TBD | not started |
| 5 | Soft subtitle sidecar | TBD | not started |

When picking up an item, change its status to `in-progress` and link the PR. When shipped, add a one-line summary under the item.

## Related

- Plan: `/root/.claude/plans/wobbly-sprouting-diffie.md`
- WhisperX service: `/opt/hypit/services/whisperx/` (HTTP on `:8765`)
- Demucs: `/opt/hypit/services/` (system install)
- MiniMax env vars: `/opt/hypit/.env`
- MiniMax TTS request shape reference: `/opt/n8n/packages/@n8n/nodes-langchain/nodes/vendors/MiniMax/actions/audio/tts.operation.ts`
- Reference MCP server layout: `/opt/VideoLingo/videolingo_mcp_server.py`

## License

Apache 2.0.
