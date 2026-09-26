# `__main__.py` — argparse CLI Entry

`tools/dub-server/dub_server/__main__.py` exposes the same `pipeline.py`
functions over a shell-friendly argparse interface. It also re-exports the
FastMCP server via the `serve` subcommand, so `python -m dub_server` is the
**single entry point** for every invocation pattern.

Top of the file documents the three ways to run:

```bash
# 1. MCP service (default transport) — wire up to any MCP client
python -m dub_server serve stdio
python -m dub_server serve streamable-http --host 0.0.0.0 --port 8766

# 2. Direct CLI subcommands — no MCP client needed
python -m dub_server dub --source video.mp4 --target-lang zh-CN --output out.mp4
python -m dub_server transcribe --audio foo.wav --language en --output transcript.json
python -m dub_server separate --audio foo.wav --model htdemucs_ft --print-paths

# 3. Library import
from dub_server.pipeline import dub_video
```

---

## Top-level dispatch — `main()` (lines 233–271)

```python
def main(argv=None) -> int:
    args = parser.parse_args(argv)

    # ① No subcommand → back-compat: `python -m dub_server stdio`
    if args.cmd is None:
        positional = [a for a in (argv or sys.argv[1:]) if not a.startswith("-")]
        transport = positional[0] if positional else "stdio"
        if transport not in ("stdio", "streamable-http", "sse"):
            parser.error(f"unknown command: {transport!r}. Try `dub-server --help`.")
        from dub_server.server import mcp
        mcp.run(transport=transport)
        return 0

    # ② `serve` → forward to FastMCP
    if args.cmd == "serve":
        return _run_serve(args)

    # ③ Business subcommands → eager Config + Registry
    from dub_server.config import Config
    from dub_server.jobs import JobRegistry
    config = Config.from_env()
    registry = JobRegistry(config.job_root, max_jobs=10)
    registry.sweep()

    if args.cmd == "dub":        return _run_dub(args, config=config, registry=registry)
    if args.cmd == "transcribe":  return _run_transcribe(args, config=config, registry=registry)
    if args.cmd == "separate":    return _run_separate(args, config=config, registry=registry)
    return 2
```

### Three dispatch patterns

| Subcommand | Builds Config/Registry | Lock | Output |
|---|---|---|---|
| `serve` (MCP stdio / HTTP) | Lazy (in `server.py`'s `_state()`) | `JOB_LOCK` (intra-tool, in server.py) | MCP protocol on stdout, logs to stderr |
| `dub` / `transcribe` / `separate` | **Eager** (right here in `main()`) | **None** | JSON dict on stdout, errors on stderr |

The eager vs lazy split matters:

- **MCP server**: lazy because unit tests can `import server` without
  touching env vars or doing filesystem work
- **CLI**: eager because each invocation is short-lived; building once and
  passing down is fine

The CLI's **no lock** is a deliberate trade-off. CLI invocations are expected
to be serialised by their caller (cron, shell scripts). If two CLIs ran
concurrently against the same `JOB_ROOT`, they'd race in `JobRegistry`. To
serialise across processes, the caller would need an external flock — but for
the current single-CLI-cron usage pattern, that's overkill.

---

## `cmd is None` — back-compat for `python -m dub_server stdio` (lines 239–249)

```python
if args.cmd is None:
    positional = [a for a in (argv or sys.argv[1:]) if not a.startswith("-")]
    transport = positional[0] if positional else "stdio"
    ...
    mcp.run(transport=transport)
    return 0
```

`sub.add_subparsers(dest="cmd", required=False)` makes the subcommand
optional. The first positional argument becomes the transport name. This
preserves the older invocation style where users wrote `python -m dub_server stdio`
instead of `python -m dub_server serve stdio`. New code should use `serve`
explicitly.

---

## The three business subcommands share one skeleton

`_run_dub` (lines 122–165), `_run_transcribe` (168), `_run_separate` (196) are
structurally identical: argparse → Pydantic schema → JobRegistry.create() →
pipeline call → JSON output.

### `_run_dub` (lines 122–165) — the most complete example

```python
def _run_dub(args, *, config, registry) -> int:
    from dub_server.schemas import DubRequest

    req = DubRequest(
        source_video_path=args.source,
        source_language=args.source_lang,
        target_language=args.target_lang,
        voice=args.voice,
        mode=args.mode,
        model=args.model,
        burn_subtitles=not args.no_burn_subs,
        output_path=args.output,
    )
    job = registry.create()
    registry.start(job.job_id)
    try:
        from dub_server.pipeline import dub_video, PipelineError
        result = dub_video(req, config=config, job=job)
        registry.complete(job.job_id, result.model_dump(mode="json"))
    except PipelineError as e:
        registry.fail(job.job_id, str(e))
        print(f"PIPELINE_ERROR: {e}", file=sys.stderr)
        return 1
    except Exception as e:                        # noqa: BLE001
        registry.fail(job.job_id, repr(e))
        print(f"UNEXPECTED: {type(e).__name__}: {e}", file=sys.stderr)
        return 1

    payload = {
        "job_id": result.job_id,
        "output_path": result.output_path,
        "voice_used": result.voice_used,
        "model_used": result.model_used,
        "transcript_segments": len(result.transcript),
        "warnings": result.warnings,
        "timings_ms": result.timings_ms,
        "loudness_per_sec_db": [
            {"sec": p.sec, "mean_db": p.mean_db}
            for p in result.loudness_per_sec_db
        ],
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0
```

Eight moves:

1. **Local `from dub_server...`** imports inside the function — keeps startup
   fast, especially on cold CLI invocation
2. **argparse → Pydantic `DubRequest`** — same schema as MCP, validated in
   one place
3. **`registry.create()`** allocates workspace + log
4. **`registry.start()`** marks running
5. **`pipeline.dub_video(req, config=config, job=job)`** — same call as
   `server.py`'s tool handler
6. **`PipelineError` branch** — registered as failed, exit 1, message on stderr
7. **`Exception` catch-all** — `_run_dub` has it; `_run_transcribe` and
   `_run_separate` don't (see note below)
8. **Custom JSON payload** — CLI version flattens `LoudnessPoint` to
   `{"sec": ..., "mean_db": ...}` dict, picks only the fields a shell user
   typically wants. (`server.py` returns `result.model_dump(mode="json")` —
   the full Pydantic tree.)

### Differences across the three CLI subcommands

| Dimension | `dub` | `transcribe` | `separate` |
|---|---|---|---|
| Pipeline function | `dub_video` | `transcribe_audio` | `separate_audio` |
| Schema | `DubRequest` | `TranscribeRequest` | `SeparateRequest` |
| PipelineError catch | ✅ | ✅ | ✅ |
| Generic `Exception` catch | ✅ | ❌ | ❌ |
| Output fields | job_id, output_path, voice, model, transcript count, warnings, timings, loudness | job_id, language, segments | depends on `--print-paths` flag |
| Output routing | stdout JSON (always) | stdout or `--output` file | stdout (if `--print-paths`) or stderr path table |

**Note**: `_run_transcribe` and `_run_separate` only catch `PipelineError`
(lines 178–181 and 206–209). Anything else (`KeyError`, etc.) propagates to
`main()`, which doesn't have a catch-all either, so the process exits with
non-zero and Python prints a traceback to stderr. `_run_dub` does catch
generics — there's a small consistency gap here. Not a bug per se, but worth
noting.

---

## `_run_serve` (lines 227–230)

```python
def _run_serve(args) -> int:
    from dub_server.server import mcp
    mcp.run(transport=args.transport, host=args.host, port=args.port)
    return 0
```

Pure forwarding. `mcp.run()` is blocking, so this never returns 0 unless
the process gets SIGINT / SIGTERM. The bottom of the file handles that:

```python
if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
```

---

## Comparison: `server.py` vs `__main__.py`

| | `server.py` (MCP) | `__main__.py` (CLI) |
|---|---|---|
| Trigger | Claude / Codex via stdio | shell / cron directly |
| Args | JSON-RPC `DubRequest` | argparse flags → same schema |
| Lock | `JOB_LOCK` serialises all tool calls | None — caller assumed serial |
| Config / Registry | Lazy (`_state()`) | Eager (built in `main()`) |
| Exception handling | All caught, wrapped to `{"error": ...}` dict | `PipelineError` + `dub` only catches generic; others propagate |
| Output | FastMCP serialises to MCP protocol | `print(json.dumps(...))` to stdout, human hints to stderr |
| Job lifecycle | same — written to registry | same — written to registry |
| Business logic | zero — pure forwarding | zero — pure forwarding |

`pipeline.py` is the only place with business logic. `server.py` and
`__main__.py` are both shells — one speaks MCP, one speaks shell — and they
call the same functions with the same schemas and the same lifecycle.

---

## Practical: launching the server

`bin/start-mcp.sh` is the production entry. It loads `/opt/hypit/.env` for
`MINIMAX_API_KEY` etc., then:

```bash
exec python -m dub_server serve stdio
```

So from the user's perspective, there's one binary: the Python module.
The CLI subcommands are how you exercise it without an MCP client.

---

## Practical: launching the CLI directly

For cron / batch jobs that don't need an MCP client:

```bash
# Dub a video
python -m dub_server dub \
  --source /opt/some/in.mp4 \
  --target-lang zh-CN \
  --voice auto \
  --mode ml-separate \
  --model htdemucs \
  --output /opt/some/out.mp4

# Just transcribe (no TTS, no mux)
python -m dub_server transcribe \
  --audio /opt/some/in.wav \
  --language en \
  --output /tmp/transcript.json

# Just demucs (no ASR, no TTS)
python -m dub_server separate \
  --audio /opt/some/in.wav \
  --model htdemucs_ft \
  --print-paths   # → {"vocals_path": ..., "no_vocals_path": ...} on stdout
```