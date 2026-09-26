#!/usr/bin/env bash
# Wrapper for the hypit-dub MCP stdio server.
#
# Sourcing /opt/hypit/.env into the server's environment is required:
#   - MINIMAX_BASE_URL / MINIMAX_API_KEY  (translation + TTS)
#   - MINIMAX_TTS_*                       (model, speed, voice_ids)
#   - WHISPERX_URL                         (default http://127.0.0.1:8765)
#   - JOB_ROOT / MAX_CONCURRENT_DUBS      (optional tuning)
#
# This script is the canonical command for Claude Code / Codex MCP clients
# registering `hypit-dub`. See /opt/hypit/tools/dub-server/README.md and the
# `## Sub-tooling: dub-server` section of /opt/hypit/CLAUDE.md.
set -euo pipefail

ENV_FILE="/opt/hypit/.env"
if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
fi

PROJECT_DIR="/opt/hypit/tools/dub-server"

if command -v uv >/dev/null 2>&1; then
    exec uv --directory "$PROJECT_DIR" run python -m dub_server serve stdio "$@"
fi

# Fallback if uv isn't on PATH — use the system Python with the project's
# src layout on PYTHONPATH. (uv is recommended; we don't guarantee bare
# python keeps up with the deps.)
PYTHONPATH="$PROJECT_DIR${PYTHONPATH:+:$PYTHONPATH}" \
    exec python3 -m dub_server serve stdio "$@"
