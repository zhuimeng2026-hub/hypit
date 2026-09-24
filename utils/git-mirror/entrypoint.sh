#!/bin/bash
# LAN-only git mirror entrypoint (dumb-HTTP flavour).
#
# Behaviour:
#   1. If /var/lib/git/hypit.git is absent, do `git clone --bare` from
#      HYPIT_GIT_UPSTREAM. The Hypit repo is ~150MB so expect a few minutes.
#   2. Run `git update-server-info` so clients can resolve refs.
#   3. Spawn a background loop that re-fetches every HYPIT_GIT_REFRESH_SECONDS
#      and re-runs update-server-info. Best-effort: a failed cycle is logged
#      but does not kill the container.
#   4. exec nginx in the foreground (the container's PID 1).

set -euo pipefail

REPO=/var/lib/git/hypit.git
SRC="${HYPIT_GIT_UPSTREAM:-https://github.com/hypit-ai/hypit.git}"
REFRESH="${HYPIT_GIT_REFRESH_SECONDS:-3600}"

refresh() {
    cd "$REPO"
    git fetch --prune --prune-tags --tags origin \
        '+refs/heads/*:refs/heads/*' \
        '+refs/tags/*:refs/tags/*' || return 1
    git update-server-info
}

if [ ! -d "$REPO" ]; then
    echo "[init] no mirror at $REPO — cloning from $SRC"
    git clone --bare "$SRC" "$REPO"
    (cd "$REPO" && git update-server-info)
    echo "[init] initial clone complete: $(du -sh "$REPO" | awk '{print $1}')"
else
    refresh || echo "[warn] initial refresh failed; will retry in $REFRESH s"
fi

# Background refresh loop. stdbuf -oL keeps logs unbuffered so docker logs
# surfaces them in real time.
(
    while true; do
        sleep "$REFRESH"
        echo "[refresh] git fetch origin $(date -Iseconds)"
        if ! refresh; then
            echo "[refresh] fetch failed; will retry next cycle"
        fi
    done
) &

# nginx in the foreground is PID 1; signals reach it directly.
exec nginx -g 'daemon off;'
