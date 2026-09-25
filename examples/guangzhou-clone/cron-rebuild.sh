#!/usr/bin/env bash
# Rebuild guangzhou-clone with the latest assets, export guangzhou-final.video.
# Designed to run unattended (no TTY, no Claude): logs everything to a
# timestamped file under .hypit/cron-logs/.
set -u
set -o pipefail

PROJECT="/opt/hypit/examples/guangzhou-clone"
LOGDIR="$PROJECT/.hypit/cron-logs"
mkdir -p "$LOGDIR"

# Every cron invocation gets its own timestamp suffix used for: log file,
# build title, and exported MP4 path. That way two runs in the same hour
# never collide.
TS=$(date +%Y%m%d-%H%M%S)
LOG="$LOGDIR/rebuild-${TS}.log"

{
  echo "==== hypit-guangzhou-cron ===="
  echo "started: $(date -Iseconds)"
  echo "host: $(hostname)"
  echo "project: $PROJECT"
  echo "ts: $TS"
  echo
} > "$LOG"

# 1. rebuild — submit a Build, capture the id
cd "$PROJECT"
echo "[1/3] hypit build ..." | tee -a "$LOG"
BUILD_OUT=$(/opt/hypit/bin/hypit.mjs build ./guangzhou.svrun \
  --runtime ./hypit.runtime.json \
  --title "guangzhou-cron-$TS" \
  --json 2>&1)
echo "$BUILD_OUT" >> "$LOG"

BUILD_ID=$(printf '%s' "$BUILD_OUT" \
  | python3 -c 'import json,sys,re
raw=sys.stdin.read()
m=re.search(r"bld_\d{8,}_[A-Z0-9]+", raw)
print(m.group(0) if m else "")')

if [ -z "$BUILD_ID" ]; then
  echo "FAIL: no build id parsed from output" | tee -a "$LOG"
  echo "ended: $(date -Iseconds)" >> "$LOG"
  exit 1
fi
echo "build id: $BUILD_ID" | tee -a "$LOG"

# 2. wait for completion (poll up to 30 min)
echo "[2/3] waiting for build to finish ..." | tee -a "$LOG"
DEADLINE=$(( $(date +%s) + 1800 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  STATE=$(/opt/hypit/bin/hypit.mjs status "$BUILD_ID" --json 2>/dev/null \
    | python3 -c 'import json,sys
try:
  j=json.load(sys.stdin)
  print(j.get("state") or j.get("outcome") or "")
except Exception:
  print("")')
  echo "  $(date +%H:%M:%S) state=$STATE" >> "$LOG"
  case "$STATE" in
    complete|succeeded|failed|cancelled|errored) break ;;
  esac
  sleep 30
done
echo "final state: $STATE" | tee -a "$LOG"

# 3. export final video
echo "[3/3] exporting guangzhou-final.video ..." | tee -a "$LOG"
OUT="$LOGDIR/guangzhou-cron-$TS.mp4"
/opt/hypit/bin/hypit.mjs get "$BUILD_ID" --output guangzhou-final.video --to "$OUT" 2>&1 | tee -a "$LOG"
ls -la "$OUT" 2>/dev/null | tee -a "$LOG"

echo "ended: $(date -Iseconds)" | tee -a "$LOG"
echo "log: $LOG"