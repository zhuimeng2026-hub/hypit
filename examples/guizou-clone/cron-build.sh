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

# Cron runs with a minimal PATH and no shell init files, so the
# default `node` on the lookup path may resolve to whatever the OS
# shipped (e.g. /usr/bin/node → v22.13.1) instead of the nvm-managed
# v22.22.1 the project was developed against. Hypit's distribution-
# resolution.ts imports node:module#registerHooks, which only exists
# in Node 22.15+. Pin to the nvm-managed binary so we always run on a
# compatible runtime. Override by exporting HYPIT_NODE_BIN.
NODE_BIN="${HYPIT_NODE_BIN:-/root/.nvm/versions/node/v22.22.1/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node)"
fi

# Prepend the node bin dir to PATH so the `#!/usr/bin/env node` shebang
# in hypit.mjs (and any subprocesses) resolve to the pinned binary too.
export PATH="$(dirname "$NODE_BIN"):$PATH"

echo "=== $(date -Iseconds) cron-build start ===" >> "$LOG"
echo "node: $($NODE_BIN -v) at $NODE_BIN" >> "$LOG"
cd "$PROJECT_DIR"

echo "--- runtime status ---" >> "$LOG"
"$NODE_BIN" /opt/hypit/bin/hypit.mjs paths >> "$LOG" 2>&1

echo "--- build start ---" >> "$LOG"
"$NODE_BIN" /opt/hypit/bin/hypit.mjs build "$RUN_FILE" \
  --runtime "$RUNTIME_JSON" \
  >> "$LOG" 2>&1 || true

# Pull the most recent build id from the work directory and run inspect.
LATEST=$(ls -t /opt/hypit/examples/guizou-clone/.hypit/runtimes/local/work/ 2>/dev/null \
  | head -1 || true)
if [ -n "$LATEST" ]; then
  echo "--- inspect $LATEST ---" >> "$INSPECT_LOG"
  "$NODE_BIN" /opt/hypit/bin/hypit.mjs inspect "$LATEST" --workspace "$PROJECT_DIR" \
    >> "$INSPECT_LOG" 2>&1 || true
fi

echo "=== $(date -Iseconds) cron-build done ===" >> "$LOG"