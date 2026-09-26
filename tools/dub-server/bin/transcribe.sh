#!/usr/bin/env bash
# One-shot wrapper for `python -m dub_server transcribe`.
#
# Transcribes a video or audio file via the local whisperx service.
# Outputs a JSON with detected language + word-level segments.
#
# Usage:
#   bin/transcribe.sh <input.mp4|input.wav> [--output FILE] [--language CODE]
#
# Examples:
#   # Auto-detect language, write JSON next to source file
#   bin/transcribe.sh /opt/hypit/source_video/gz-exbi.mp4
#
#   # Specify output path
#   bin/transcribe.sh /opt/hypit/source_video/gz-exbi.mp4 --output /tmp/transcript.json
#
#   # Force language hint, dump to stdout
#   bin/transcribe.sh /opt/hypit/source_video/gz-exbi.mp4 --language zh \
#     | jq '{lang: .language, segments: (.segments | length)}'
#
# Behaviour:
#   - Loads /opt/hypit/.env into process env (override with DUB_ENV_FILE=...)
#   - Prefers uv; falls back to .venv/bin/python (matches bin/start-mcp.sh)
#   - Pre-flight: input file exists, whisperx /health returns 200
#   - First positional arg is wrapped as --audio automatically
#
# See also:
#   - tools/dub-server/docs/cli.md        (full argparse reference)
#   - tools/dub-server/bin/start-mcp.sh   (sibling wrapper, MCP stdio)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load .env (DUB_ENV_FILE lets tests / other projects override)
ENV_FILE="${DUB_ENV_FILE:-/opt/hypit/.env}"
if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
fi

# Pick uv (preferred) or fall back to .venv/bin/python
if command -v uv >/dev/null 2>&1; then
    PYTHON_CMD=(uv --directory "$PROJECT_DIR" run python)
elif [ -x "$PROJECT_DIR/.venv/bin/python" ]; then
    PYTHON_CMD=("$PROJECT_DIR/.venv/bin/python")
else
    echo "ERROR: neither uv nor $PROJECT_DIR/.venv/bin/python available" >&2
    exit 1
fi

# Help text if no args
if [ $# -eq 0 ]; then
    cat >&2 <<EOF
Usage: $0 <input.mp4|input.wav> [--output FILE] [--language CODE]

Examples:
  $0 /opt/hypit/source_video/gz-exbi.mp4
  $0 /opt/hypit/source_video/gz-exbi.mp4 --output /tmp/transcript.json

Run '${PYTHON_CMD[*]} -m dub_server transcribe --help' for full argparse options.
EOF
    exit 2
fi

# Wrap positional first arg as --audio (matches dub_server.schemas.TranscribeRequest)
# Short-circuit --help / --version before any pre-flight checks
for arg in "$@"; do
    case "$arg" in
        -h|--help|--version) exec "${PYTHON_CMD[@]}" -m dub_server transcribe "$@" ;;
    esac
done
if [[ "${1:-}" != --* ]]; then
    set -- --audio "$@"
fi

# Extract --audio's value for the pre-flight existence check.
# Accepts both --audio PATH and --audio=PATH forms.
INPUT_PATH=""
prev=""
for arg in "$@"; do
    case "$arg" in
        --audio=*) INPUT_PATH="${arg#--audio=}"; break ;;
        --audio)   : ;;
        *)
            if [ "$prev" = "--audio" ]; then
                INPUT_PATH="$arg"
                break
            fi
            ;;
    esac
    prev="$arg"
done

if [ -z "$INPUT_PATH" ]; then
    echo "ERROR: --audio requires a path argument" >&2
    exit 2
fi
if [ ! -f "$INPUT_PATH" ]; then
    echo "ERROR: input file not found: $INPUT_PATH" >&2
    exit 1
fi

# Pre-flight: whisperx reachable
WHISPERX_URL="${WHISPERX_URL:-http://127.0.0.1:8765}"
if ! curl -sf --max-time 3 "$WHISPERX_URL/health" >/dev/null 2>&1; then
    cat >&2 <<EOF
ERROR: whisperx not reachable at $WHISPERX_URL
Start it with: /opt/hypit/services/whisperx/.venv/bin/hypit-whisperx-service &
EOF
    exit 1
fi

exec "${PYTHON_CMD[@]}" -m dub_server transcribe "$@"