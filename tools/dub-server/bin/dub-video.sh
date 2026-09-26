#!/usr/bin/env bash
# End-to-end dub a video via hypit-dub-server.
#
# Wraps:
#   1. /opt/hypit/.env  (MINIMAX_API_KEY, voice defaults)
#   2. WhisperX service  (must be reachable at $WHISPERX_URL)
#   3. demucs binary     (CPU stem separation, ~10× realtime on htdemucs_ft)
#   4. `hypit-dub dub`   (orchestrator CLI from dub-server)
#
# Usage:
#   bin/dub-video.sh /path/to/source.mp4                  # en-female, ml-separate, htdemucs_ft
#   bin/dub-video.sh --voice en-male --model htdemucs in.mp4
#   bin/dub-video.sh --no-burn-subs --mode stereo-mix in.mp4 out.mp4
#
# All flags pass through to `hypit-dub dub`. Run `uv run hypit-dub dub --help`
# inside /opt/hypit/tools/dub-server for the canonical list.
set -uo pipefail

REPO_ROOT="/opt/hypit"
DUB_DIR="$REPO_ROOT/tools/dub-server"
ENV_FILE="$REPO_ROOT/.env"
WHISPERX_URL="${HYPIT_DUB_WHISPERX_URL:-http://127.0.0.1:8765}"

# ---- colour helpers (auto-disabled when not a TTY) ----
if [[ -t 1 ]]; then
    _C_RESET=$'\033[0m'; _C_RED=$'\033[31m'; _C_GREEN=$'\033[32m'; _C_YELLOW=$'\033[33m'; _C_BLUE=$'\033[34m'; _C_BOLD=$'\033[1m'
else
    _C_RESET=""; _C_RED=""; _C_GREEN=""; _C_YELLOW=""; _C_BLUE=""; _C_BOLD=""
fi
info()  { printf '%s==>%s %s\n' "$_C_BLUE"  "$_C_RESET" "$*"; }
ok()    { printf '%s ✓ %s%s\n' "$_C_GREEN" "$*" "$_C_RESET"; }
warn()  { printf '%s !! %s%s\n' "$_C_YELLOW" "$*" "$_C_RESET"; }
err()   { printf '%s ✗ %s%s\n' "$_C_RED"    "$*" "$_C_RESET" >&2; }
die()   { err "$*"; exit 1; }

# ---- 1. load .env (MINIMAX_API_KEY, voice defaults) ----
if [[ ! -f "$ENV_FILE" ]]; then
    die "missing $ENV_FILE — copy from .env.example and fill MINIMAX_API_KEY"
fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${MINIMAX_API_KEY:?MINIMAX_API_KEY is empty in $ENV_FILE}"
ok "loaded $ENV_FILE (MINIMAX_API_KEY=${MINIMAX_API_KEY:0:8}...)"

# ---- 2. whisperx health check ----
if ! curl -fsS --max-time 5 "$WHISPERX_URL/health" >/tmp/dub-video-whisperx-health.json 2>/dev/null; then
    die "whisperx not reachable at $WHISPERX_URL — start it first (see services/whisperx/README.md)"
fi
ok "whisperx reachable at $WHISPERX_URL"

# ---- 3. demucs on PATH ----
if ! command -v demucs >/dev/null 2>&1; then
    die "demucs not on PATH — install with: pip install demucs  (or system package)"
fi
ok "demucs $(command -v demucs)"

# ---- 4. ffmpeg on PATH ----
command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg not on PATH"
ok "ffmpeg $(command -v ffmpeg)"

# ---- 5. positional source / output handling ----
# Anything before the first `--` is fair game; we just pass everything through
# to `hypit-dub dub`. We do only a sanity check on the source file.

# Pull --source / --output off the arg list (so we can validate them)
_args=("$@")
src=""
out=""
for i in "${!_args[@]}"; do
    a="${_args[$i]}"
    case "$a" in
        --source)  src="${_args[$((i+1))]:-}";;
        --source=*) src="${a#*=}";;
        --output)  out="${_args[$((i+1))]:-}";;
        --output=*) out="${a#*=}";;
    esac
done
if [[ -z "$src" ]]; then
    # Maybe the last positional is the source and second-to-last is output.
    for (( idx=${#_args[@]}-1; idx>=0; idx-- )); do
        a="${_args[$idx]}"
        if [[ "$a" != --* ]] && [[ -f "$a" ]]; then
            [[ -z "$src" ]] && src="$a" || { out="$src"; src="$a"; }
        fi
    done
fi
[[ -n "$src" ]] || die "no source file given (--source PATH or positional)"
[[ -f "$src" ]] || die "source not found: $src"

# If user passed source positionally (no --source flag), the downstream
# `hypit-dub dub` only accepts --source, so promote the positional to a flag.
_has_source_flag=""
for a in "$@"; do
    case "$a" in
        --source|--source=*) _has_source_flag=1;;
    esac
done
if [[ -z "$_has_source_flag" ]]; then
    # Drop the positional source from $@, prepend --source "$src"
    _new_args=(--source "$src")
    for a in "$@"; do
        if [[ "$a" != "$src" ]]; then _new_args+=("$a"); fi
    done
    set -- "${_new_args[@]}"
fi

# Audio-only shortcut: a single .wav/.mp3 still works (whisperx accepts both).
src_size=$(stat -c '%s' "$src" 2>/dev/null || stat -f '%z' "$src")
info "source: $src ($((src_size / 1024 / 1024)) MiB)"

# ---- 5b. duration-based model heuristic ----
# If the caller didn't pin --model, pick by video length so a 30-min clip
# doesn't silently commit to a 5-hour demucs run. Caller can always
# override with --model.
_has_model=""
for a in "$@"; do
    case "$a" in
        --model|--model=*) _has_model=1;;
    esac
done
if [[ -z "$_has_model" ]]; then
    src_dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src" 2>/dev/null | head -1)
    if [[ -n "$src_dur" ]]; then
        src_dur_int=${src_dur%.*}
        dur_min=$(awk -v s="$src_dur" 'BEGIN{printf "%.1f", s/60}')
        if (( src_dur_int < 180 )); then
            set -- --model htdemucs_ft "$@"
            info "auto-selected --model htdemucs_ft (duration ${dur_min}min, high-quality)"
        elif (( src_dur_int < 600 )); then
            set -- --model htdemucs "$@"
            info "auto-selected --model htdemucs (duration ${dur_min}min, 3× faster than _ft)"
        else
            set -- --model htdemucs "$@"
            warn "duration ${dur_min}min — demucs ml-separate would take ~$((src_dur_int / 6))min. Consider --mode stereo-mix to skip separation (~10× faster)."
        fi
    else
        warn "could not probe duration; falling through with default --model htdemucs"
    fi
fi

# ---- 6. invoke dub CLI ----
cd "$DUB_DIR" || die "cannot cd $DUB_DIR"
info "running: uv run hypit-dub dub $*"
echo

exec uv run hypit-dub dub "$@"