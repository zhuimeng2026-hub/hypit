#!/bin/bash
# Scheduled build wrapper for examples/guizou-clone.
# Runs the Hypit build, captures status to a log, and records the
# resulting Build id so a follow-up inspect can pick it up.
#
# Triggered by cron at 2026-09-26 01:00 (see crontab -l).
# Software GPU on this host makes HyperFrames render painfully slow
# at full resolution; the SVML is currently in smoke-test sizing
# (360x640, 10 fps) so a single build completes in ~hours rather
# than days. Inspect runtime.json for the trade-off knobs.

set -e

PROJECT_DIR=/opt/hypit/examples/guizou-clone
RUNTIME_JSON="${PROJECT_DIR}/hypit.runtime.json"
RUN_FILE="${PROJECT_DIR}/guizou.svrun"
LOG=/tmp/guizou-cron-build.log
INSPECT_LOG=/tmp/guizou-cron-inspect.log

echo "=== $(date -Iseconds) cron-build start ===" >> "$LOG"
cd "$PROJECT_DIR"

# Make sure the runtime.json binding for whisperx.local is honored.
# (binding is already in the file; this is just defensive.)

echo "--- runtime status ---" >> "$LOG"
/opt/hypit/bin/hypit.mjs paths >> "$LOG" 2>&1

echo "--- build start ---" >> "$LOG"
/opt/hypit/bin/hypit.mjs build "$RUN_FILE" \
  --runtime "$RUNTIME_JSON" \
  >> "$LOG" 2>&1 || true

# Pull the most recent build id from the work directory and run inspect.
LATEST=$(ls -t /opt/hypit/examples/guizou-clone/.hypit/runtimes/local/work/ 2>/dev/null \
  | head -1 || true)
if [ -n "$LATEST" ]; then
  echo "--- inspect $LATEST ---" >> "$INSPECT_LOG"
  /opt/hypit/bin/hypit.mjs inspect "$LATEST" --workspace "$PROJECT_DIR" \
    >> "$INSPECT_LOG" 2>&1 || true
fi

echo "=== $(date -Iseconds) cron-build done ===" >> "$LOG"