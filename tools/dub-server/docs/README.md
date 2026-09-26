# `dub-server` — Internal Architecture

> Local MCP / CLI service that dubs a short video into another language by chaining
> whisperx ASR → MiniMax translate → MiniMax TTS (with edge-tts fallback) → ffmpeg
> mux + ASS subtitle burn. Lives at `tools/dub-server/`, separate from the
> `@hypit/hypit` npm Distribution.

## What it does

Take a video like `interview.mp4` (English, 60 s) and produce `interview-zh-CN.mp4`
with:

- Chinese voiceover, paced to the original timeline (TTS tempo-corrected to fit each segment's slot)
- Chinese ASS subtitles burned into the video (Noto Sans CJK SC, 720×1280 frame)
- An optional clean bed (`stereo-mix` / `phase-cancel` / `ml-separate` via demucs) underneath the new voice
- A per-second loudness profile + bed-vs-voice isolation metric for QA

## Three ways to invoke it

```bash
# 1. MCP stdio (Claude Code / Codex register under mcpServers.hypit-dub)
python -m dub_server serve stdio
# or just: python -m dub_server stdio  (back-compat shortcut)

# 2. Direct CLI (cron, shell scripts, web backends)
python -m dub_server dub --source foo.mp4 --target-lang zh-CN --output bar.mp4
python -m dub_server transcribe --audio foo.wav --output transcript.json
python -m dub_server separate --audio foo.wav --model htdemucs_ft --print-paths

# 3. Library import
from dub_server.pipeline import dub_video
```

## File layout

```
tools/dub-server/
├── pyproject.toml            # uv-managed; Python 3.10+
├── uv.lock
├── README.md                 # User-facing: install + run
├── bin/start-mcp.sh          # Wraps `python -m dub_server serve stdio`
│                             #   with /opt/hypit/.env loaded (MINIMAX_API_KEY etc.)
├── _smoke/                   # Manual smoke scripts (used during dev)
└── dub_server/
    ├── __init__.py
    ├── __main__.py           # argparse subcommands: serve / dub / transcribe / separate
    ├── server.py             # FastMCP: exposes the 3 tools over stdio
    ├── pipeline.py           # 9-stage orchestration, public library entry points
    ├── schemas.py            # Pydantic request/result/segment/word/loudness models
    ├── config.py             # Frozen dataclass aggregating env vars
    ├── jobs.py               # Job / JobRegistry / JOB_LOCK
    ├── logging_setup.py      # Routes all logs to stderr (stdout is MCP protocol)
    └── backends/             # Leaf adapters — one file per external service
        ├── __init__.py       # Flat re-export of public symbols
        ├── ffmpeg.py         # probe / extract / mux / per-second RMS
        ├── whisperx.py       # HTTP client for the local ASR service
        ├── demucs.py         # subprocess wrapper around the demucs CLI
        ├── edge_tts.py       # async + sync wrappers around edge-tts CLI
        ├── minimax_tts.py    # Direct MiniMax /v1/t2a_v2 client (hex output)
        ├── minimax_llm.py    # Direct MiniMax /v1/chat/completions client
        ├── prompts.py        # Translation prompt templates
        └── align.py          # Single-ffmpeg filter_complex TTS → timeline aligner
```

## Layered architecture

```
              ┌──────────────────────────────────────────────────────┐
              │               LLM / shell / cron                     │
              │  mcp__hypit-dub__dub_video(source=..., mode=...)     │
              └───────────────────┬──────────────────────────────────┘
                                  │ JSON-RPC / argparse
                                  ▼
        ┌──────────────────────┐    ┌──────────────────────┐
        │    server.py         │    │    __main__.py       │
        │  FastMCP wrapper     │    │  argparse wrapper    │
        │  • schema validation │    │  • schema validation │
        │  • JOB_LOCK          │    │  • no lock           │
        │  • lazy Config+Reg   │    │  • eager Config+Reg  │
        └──────────┬───────────┘    └──────────┬───────────┘
                   │     same library call     │
                   └─────────────┬────────────┘
                                 ▼
              ┌─────────────────────────────────────┐
              │           pipeline.py                │
              │  9-stage orchestrator               │
              │  • resolve voice + bed mode         │
              │  • extract → ASR → split → translate│
              │  • TTS → align → mix → mux          │
              │  • per-stage timings_ms             │
              └────┬──────────────┬───────────┬────┘
                          │              │           │
              ┌───────────┴──┐  ┌────────┴────┐  ┌──┴────────────┐
              │ schemas.py   │  │ jobs.py     │  │ config.py     │
              │ Request/Result│  │ JobRegistry │  │ frozen env    │
              │ Segment/Word │  │ JOB_LOCK    │  │ snapshot      │
              └──────────────┘  └─────────────┘  └───────────────┘
                                 │
                                 ▼
              ┌─────────────────────────────────────┐
              │        backends/  (8 files)          │
              │  ffmpeg / whisperx / demucs /        │
              │  edge-tts / minimax_tts / llm /     │
              │  align / prompts                     │
              │  stateless leaf adapters             │
              │  one exception type per backend      │
              └─────────────────────────────────────┘
```

## Reading order for newcomers

If you're new to the codebase, read in this order:

1. **`schemas.py`** (84 lines) — the contracts. Once you understand `DubRequest`,
   `Segment`, `WordTiming`, `LoudnessPoint`, everything else slots into place.
2. **`config.py`** (122 lines) — what env vars control what. Defaults mirror
   `/opt/hypit/.env`.
3. **`jobs.py`** (230 lines) — `Job`, `JobRegistry`, the `JOB_LOCK` that serialises
   all dub execution.
4. **`pipeline.py`** (~1090 lines) — the 9-stage orchestrator. The heart of the
   service.
5. **`server.py`** (208 lines) — thin FastMCP wrapper around pipeline.py.
6. **`__main__.py`** (278 lines) — argparse CLI wrapper around the same pipeline.
7. **`backends/`** (8 files, ~1000 lines total) — leaf adapters for each external
   service.

## Per-file deep dives

- [pipeline.md](pipeline.md) — `pipeline.py` 9-stage orchestrator
- [server.md](server.md) — `server.py` FastMCP wrapper
- [cli.md](cli.md) — `__main__.py` argparse CLI
- [jobs.md](jobs.md) — `jobs.py` Job lifecycle + JOB_LOCK
- [config.md](config.md) — `config.py` env-var aggregation
- [schemas.md](schemas.md) — `schemas.py` Pydantic contracts
- [backends.md](backends.md) — `backends/` 8 leaf adapters

## Operating principles (apply across the whole package)

- **Pipeline is the only place that knows ordering or fallback policy.** Backends
  are stateless leaf adapters; wrappers (server, CLI) don't know what stages exist.
- **One exception type per backend.** `FFmpegError`, `WhisperXError`,
  `WhisperXBusy`, `DemucsError`, `EdgeTTSError`, `MiniMaxTTSError`,
  `MiniMaxChatError`, `RuntimeError` (align). The pipeline catches each by name
  and routes to the right fallback.
- **`Config` is the only way external dependencies enter the system.** Every
  backend takes `base_url` / `api_key` / `*_bin` as function arguments, never
  reads `os.environ` itself. `Config.from_env()` is the single env-var reader.
- **`Job` is the only way runtime state enters the system.** Each pipeline call
  gets a `Job` from `JobRegistry.create()` and stamps its workspace / log path
  / lifecycle onto it.
- **`extra="forbid"` on Request schemas, `extra="allow"` on Result schemas.**
  Strict inbound (catch LLM schema drift early), permissive outbound (forward-
  compatible with backend evolution).
- **JOB_LOCK is intra-process only.** Two `python -m dub_server serve` processes
  don't see each other's locks — single-process is assumed.
- **stdout is reserved for JSON / MCP protocol.** All logs go to stderr via
  `logging_setup.setup_logging`.