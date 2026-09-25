#!/usr/bin/env bash
# Generate the narration mp3 via edge-tts. Defaults match
# `examples/guangzhou-clone/gen-tts.sh`. Caller supplies the text via --text
# or stdin, and the output path via --out.
#
# Usage:
#   gen-tts.sh --text "Welcome to Guangzhou. ..." --out /path/narration.mp3
#   gen-tts.sh --voice en-US-GuyNeural --rate -30% --out narration.mp3 < text.txt

set -euo pipefail

VOICE="${VOICE:-en-US-GuyNeural}"
RATE="${RATE:--30%}"
TEXT=""
OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --voice) VOICE="$2"; shift 2 ;;
    --rate)  RATE="$2";  shift 2 ;;
    --text)  TEXT="$2";  shift 2 ;;
    --out)   OUT="$2";   shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$OUT" ]; then
  echo "--out is required" >&2
  exit 2
fi

if [ -z "$TEXT" ]; then
  TEXT=$(cat)
fi

if [ -z "$TEXT" ]; then
  echo "no narration text provided (use --text or stdin)" >&2
  exit 2
fi

mkdir -p "$(dirname "$OUT")"
edge-tts --voice "$VOICE" --rate "$RATE" --text "$TEXT" --write-media "$OUT" >/dev/null
ls -la "$OUT"
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUT" \
  | awk '{print "duration: " $1 "s"}'