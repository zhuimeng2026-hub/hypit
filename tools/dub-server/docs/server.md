# `server.py` — FastMCP Wrapper

`tools/dub-server/dub_server/server.py` is **208 lines** and contains **zero
business logic**. Its job is to expose `pipeline.py`'s three synchronous
functions as three MCP tools over stdio (or HTTP / SSE).

Its docstring is the design statement:

> Synchronous calls; concurrency is bounded to **one job in flight** by a
> module-global `JOB_LOCK`. The rationale: whisperx is single-inference (503
> BUSY otherwise), demucs holds the model in memory, and two dub calls don't
> gain anything from running in parallel on this CPU host.
>
> stdout is the MCP protocol in stdio mode — logging is to stderr only.
> `logging_setup.setup_logging` enforces that.

---

## Module top — imports + aliases (lines 1–39)

```python
from .pipeline import (
    PipelineError,
    dub_video as pipeline_dub_video,        # 别名避免和 tool 函数撞名
    separate_audio as pipeline_separate,
    transcribe_audio as pipeline_transcribe,
)
```

Aliases are needed because the same module defines three MCP tools with the
same names as the pipeline functions.

Note: only `PipelineError` is imported. Backend-specific exceptions
(`FFmpegError`, `WhisperXError`, etc.) are caught by name inside `pipeline.py`
and either absorbed (with fallback) or re-raised. The server layer only
distinguishes "known recoverable" (`PipelineError`) from "anything else".

---

## Lazy global state (lines 41–57)

```python
_config: Config | None = None
_registry: JobRegistry | None = None

def _state() -> tuple[Config, JobRegistry]:
    global _config, _registry
    if _config is None:
        _config = Config.from_env()
    if _registry is None:
        _registry = JobRegistry(_config.job_root, max_jobs=10)
        _registry.sweep()
    return _config, _registry
```

Two design choices:

1. **Lazy**: `import server` does not read env vars or sweep jobs. Unit tests
   can import without polluting the environment.
2. **`max_jobs=10`** sweeps on first call: keeps the last 10 jobs' workspace
   directories; older ones are deleted.

`_state()` is called inside each tool handler — never at module import time.

---

## FastMCP application (lines 64–74)

```python
mcp = FastMCP(
    name="hypit-dub",
    instructions=(
        "Video dubbing service. Replace the audio track of a short video with "
        "target-language TTS, optionally separated from the source audio bed "
        "via demucs (ML) or stereo phase cancellation, with burned-in ASS "
        "subtitles from the translated transcript. Three tools: dub_video "
        "(end-to-end), separate_audio (return vocals + no_vocals stems), "
        "transcribe_audio (run whisperx ASR on a video/audio file)."
    ),
)
```

The `instructions` field is what Claude Code / Codex see during tool discovery.
It tells the model:

- The three tools available
- What kind of input they accept
- The default behaviour (burn subtitles, bed modes)

---

## The three tools share one template

`server.py` lines 90–200. Each `@mcp.tool` handler is structurally identical
— `dub_video` shown below:

```python
@mcp.tool(
    name="dub_video",
    description="End-to-end dub a video. ...",
)
def dub_video(req: DubRequest) -> dict[str, Any]:
    config, registry = _state()
    with JOB_LOCK:                                  # ① global serialisation lock
        job = registry.create()                     # ② allocate workspace + log
        registry.start(job.job_id)                 #    mark running
        try:
            result: DubResult = pipeline_dub_video(req, config=config, job=job)
            payload = result.model_dump(mode="json")  # ③ Pydantic → JSON-safe dict
            registry.complete(job.job_id, payload)    #    persist result
            return payload
        except PipelineError as error:                # ④ known recoverable failure
            registry.fail(job.job_id, str(error))
            return {"error": "pipeline",
                    "message": str(error),
                    "job_id": job.job_id}
        except Exception as error:                    # ⑤ catch-all
            registry.fail(job.job_id, f"unexpected: {error}")
            return {"error": "internal",
                    "message": repr(error),
                    "job_id": job.job_id}
```

Each layer has a single responsibility:

| Layer | What | Owner |
|---|---|---|
| ① `JOB_LOCK` | Serialise all dub execution to one in flight at a time | `jobs.JOB_LOCK` |
| ② registry lifecycle | `create()` → `start()` → `complete()` / `fail()` writes audit + workspace | `jobs.JobRegistry` |
| ③ `model_dump(mode="json")` | Flatten `Path` / `datetime` / `timedelta` to JSON-safe | `DubResult` schema |
| ④ `PipelineError` | Recoverable orchestration failure → structured dict return | server itself |
| ⑤ catch-all | Any unexpected exception → structured dict return (not raise) | server itself |

**Critical design choice**: exceptions never propagate to FastMCP. They are
wrapped into structured dicts so:

1. The LLM always gets a JSON object, not a stack trace. It can branch on
   `"error"` field ("pipeline error → maybe retry, internal error → give up").
2. `job_id` always comes back. Even on total failure, the client can use it
   to inspect the workspace for partial outputs (some stages may have written
   to disk already).

`transcribe_audio` and `separate_audio` (lines 145–200) follow the same
template, just with their respective Request/Result schemas.

---

## Module exports (lines 203–207)

```python
__all__ = ["mcp", "dub_video", "transcribe_audio", "separate_audio"]
```

`mcp` is exported for `bin/start-mcp.sh` / `__main__.py serve` to invoke
`mcp.run(transport="stdio")`. The three tool names are exported because
FastMCP's `@mcp.tool` decorator creates them as importable callables.

---

## Startup: `bin/start-mcp.sh`

`server.py` has no `if __name__ == "__main__"` — it relies on:

- **`__main__.py serve stdio`** for explicit invocation
- **`__main__.py stdio`** for the legacy back-compat shortcut

`bin/start-mcp.sh` is the actual production entry. It loads
`/opt/hypit/.env` (MINIMAX_API_KEY etc.) and `exec python -m dub_server serve stdio`.

Claude Code / Codex register it via `.mcp.json`:

```json
{
  "mcpServers": {
    "hypit-dub": {
      "command": "/opt/hypit/tools/dub-server/bin/start-mcp.sh"
    }
  }
}
```

After restart, the three tools appear as `mcp__hypit-dub__dub_video`,
`mcp__hypit-dub__transcribe_audio`, `mcp__hypit-dub__separate_audio`.

---

## What the wrapper does, in one sentence

> **Validate** (`DubRequest` Pydantic checks schema, including `extra="forbid"`)
> **+ serialise** (`JOB_LOCK` so concurrent dub calls don't crash whisperx / demucs)
> **+ lifecycle** (`JobRegistry.create/start/complete/fail` for audit + workspace)
> **+ classify errors** (`PipelineError` vs everything else, always return dict)
> **+ JSON-serialise** (`model_dump(mode="json")` so `Path` / `datetime` cross the MCP boundary safely)

The actual 9-stage orchestration, fallback chain, long-segment splitting,
translation retry, and ASS burn — **all lives in `pipeline.py`**. The wrapper
adds nothing.