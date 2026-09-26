"""``python -m dub_server`` entry point.

Three ways to run this:

  1. **MCP service** (default transport) — wire up to Claude/Codex/any MCP client::

         python -m dub_server serve stdio
         python -m dub_server serve streamable-http --host 0.0.0.0 --port 8766

  2. **Direct CLI subcommands** — no MCP client needed::

         python -m dub_server dub --source video.mp4 --target-lang zh-CN --output out.mp4
         python -m dub_server transcribe --audio foo.wav --language en
         python -m dub_server separate --audio foo.wav --model htdemucs

     Useful for cron, shell scripts, web backends, anything that speaks
     processes instead of MCP.

  3. **Library import** — useful from Python::

         from dub_server.pipeline import dub_video

stdout is the MCP protocol in stdio mode — we let any error that escapes
the parser go to stderr so we don't corrupt the JSON-RPC stream.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Sequence


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dub-server",
        description=(
            "Local dub pipeline runner. Three interfaces: stdio MCP service, "
            "direct CLI subcommands, or library import. Internal pipeline "
            "uses MiniMax chat (translate) + MiniMax TTS + whisperx ASR + "
            "demucs (optional vocal isolation) + ffmpeg (mux + ASS burn)."
        ),
    )
    sub = parser.add_subparsers(dest="cmd", required=False)

    # ----- serve (or unnamed "stdio" for back-compat) -----
    serve = sub.add_parser(
        "serve", help="Run as MCP service (default subcommand)",
    )
    serve.add_argument(
        "transport", nargs="?", default="stdio",
        choices=("stdio", "streamable-http", "sse"),
    )
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8766)

    # ----- dub -----
    dub = sub.add_parser("dub", help="Dub a video file end-to-end")
    dub.add_argument(
        "--log-level", default="INFO",
        choices=("DEBUG", "INFO", "WARNING", "ERROR"),
        help="Verbosity of per-stage progress logs (default INFO)",
    )
    dub.add_argument("--source", required=True, help="Source video path")
    dub.add_argument(
        "--target-lang", default="zh-CN",
        help="Target language code (default zh-CN)",
    )
    dub.add_argument(
        "--source-lang", default=None,
        help="Source language (default: auto-detect via whisperx)",
    )
    dub.add_argument(
        "--voice", default="auto",
        help='Voice id or "auto" (default: zh-male per language)',
    )
    dub.add_argument(
        "--mode", default="ml-separate",
        choices=("stereo-mix", "ml-separate", "phase-cancel"),
    )
    dub.add_argument(
        "--model", default="htdemucs",
        choices=("htdemucs", "htdemucs_ft"),
    )
    dub.add_argument(
        "--no-burn-subs", action="store_true",
        help="Skip ASS-burn (default burns subtitles into the video)",
    )
    dub.add_argument(
        "--output", default=None,
        help="Output mp4 path (default: source dir + '-<target-lang>.mp4')",
    )

    # ----- transcribe -----
    tx = sub.add_parser(
        "transcribe", help="Run whisperx ASR on a video/audio file",
    )
    tx.add_argument("--audio", required=True, help="Source video/audio path")
    tx.add_argument("--language", default=None, help="ISO language hint")
    tx.add_argument(
        "--output", default=None,
        help="Write segments JSON here (default: stdout)",
    )

    # ----- separate -----
    sp = sub.add_parser(
        "separate", help="Run demucs vocal separation only",
    )
    sp.add_argument("--audio", required=True, help="Source audio path")
    sp.add_argument(
        "--model", default="htdemucs",
        choices=("htdemucs", "htdemucs_ft"),
    )
    sp.add_argument(
        "--out-dir", default=None,
        help="Output directory (default: $JOB_ROOT/<job_id>/demucs)",
    )
    sp.add_argument(
        "--print-paths", action="store_true",
        help="Print vocals_path and no_vocals_path to stdout as JSON",
    )

    return parser


def _run_dub(args: argparse.Namespace, *, config, registry) -> int:
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
    # Apply per-call log level (the dub-server logger was created with INFO
    # by setup_logging; this tweaks it for the current job).
    logging.getLogger("dub_server").setLevel(
        getattr(logging, getattr(args, "log_level", "INFO"), "")
    )
    try:
        from dub_server.pipeline import dub_video, PipelineError

        result = dub_video(req, config=config, job=job)
        registry.complete(job.job_id, result.model_dump(mode="json"))
    except PipelineError as e:
        registry.fail(job.job_id, str(e))
        print(f"PIPELINE_ERROR: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        registry.fail(job.job_id, "interrupted by user (Ctrl-C)")
        print("\nINTERRUPTED: user cancelled mid-job", file=sys.stderr)
        return 130
    except Exception as e:  # noqa: BLE001
        registry.fail(job.job_id, repr(e))
        logging.getLogger("dub_server").exception("UNEXPECTED crash in dub run")
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


def _run_transcribe(args: argparse.Namespace, *, config, registry) -> int:
    from dub_server.schemas import TranscribeRequest
    from dub_server.pipeline import transcribe_audio, PipelineError

    req = TranscribeRequest(audio_path=args.audio, language=args.language)
    job = registry.create()
    registry.start(job.job_id)
    try:
        result = transcribe_audio(req, config=config, job=job)
        registry.complete(job.job_id, result.model_dump(mode="json"))
    except PipelineError as e:
        registry.fail(job.job_id, str(e))
        print(f"PIPELINE_ERROR: {e}", file=sys.stderr)
        return 1
    payload = {
        "job_id": result.job_id,
        "language": result.language,
        "segments": [s.model_dump() for s in result.segments],
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text + "\n", encoding="utf-8")
        print(f"wrote {args.output}", file=sys.stderr)
    else:
        print(text)
    return 0


def _run_separate(args: argparse.Namespace, *, config, registry) -> int:
    from dub_server.schemas import SeparateRequest
    from dub_server.pipeline import separate_audio, PipelineError

    req = SeparateRequest(audio_path=args.audio, model=args.model)
    job = registry.create()
    registry.start(job.job_id)
    try:
        result = separate_audio(req, config=config, job=job)
        registry.complete(job.job_id, result.model_dump(mode="json"))
    except PipelineError as e:
        registry.fail(job.job_id, str(e))
        print(f"PIPELINE_ERROR: {e}", file=sys.stderr)
        return 1
    if args.print_paths:
        print(json.dumps({
            "job_id": result.job_id,
            "vocals_path": result.vocals_path,
            "no_vocals_path": result.no_vocals_path,
            "model": result.model,
        }, ensure_ascii=False, indent=2))
    else:
        out_dir = args.out_dir
        if out_dir:
            print(f"demucs outputs written under {out_dir}", file=sys.stderr)
        else:
            print(f"vocals:      {result.vocals_path}", file=sys.stderr)
            print(f"no_vocals:   {result.no_vocals_path}", file=sys.stderr)
    return 0


def _run_serve(args: argparse.Namespace) -> int:
    from dub_server.server import mcp
    mcp.run(transport=args.transport, host=args.host, port=args.port)
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    # Back-compat: ``python -m dub_server stdio`` (no subcommand) launches
    # the stdio MCP server. New users should prefer ``python -m dub_server serve stdio``.
    if args.cmd is None:
        # Treat leftover positional argv[1] as the transport name.
        positional = [a for a in (argv or sys.argv[1:]) if not a.startswith("-")]
        transport = positional[0] if positional else "stdio"
        if transport not in ("stdio", "streamable-http", "sse"):
            parser.error(
                f"unknown command: {transport!r}. Try `dub-server --help`."
            )
        from dub_server.server import mcp
        mcp.run(transport=transport)
        return 0

    if args.cmd == "serve":
        return _run_serve(args)

    # From here on we need Config + Registry (the MCP server constructs them
    # lazily; the CLI constructs them eagerly).
    from dub_server.config import Config
    from dub_server.jobs import JobRegistry

    config = Config.from_env()
    registry = JobRegistry(config.job_root, max_jobs=10)
    registry.sweep()

    if args.cmd == "dub":
        return _run_dub(args, config=config, registry=registry)
    if args.cmd == "transcribe":
        return _run_transcribe(args, config=config, registry=registry)
    if args.cmd == "separate":
        return _run_separate(args, config=config, registry=registry)

    parser.error(f"unknown command: {args.cmd!r}")
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
