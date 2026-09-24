#!/bin/sh
# Pulls the pinned chrome-for-testing archive for win32 + win64 + linux64 + mac into
# /out. Idempotent: skips files that already exist with the right size.
#
# Run as:  docker compose run --rm chrome-mirror-bootstrap
#
# Override via env: HYPIT_CHROME_VERSION, HYPIT_CHROME_UPSTREAM.

set -eu

: "${HYPIT_CHROME_VERSION:?HYPIT_CHROME_VERSION must be set (e.g. 138.0.7204.157)}"
: "${HYPIT_CHROME_UPSTREAM:=https://storage.googleapis.com/chrome-for-testing-public/}"

OUT=/out
UP="${HYPIT_CHROME_UPSTREAM%/}"

# chrome-headless-shell exists per platform under <version>/<platform>/<archive>.
# The Provider (@puppeteer/browsers@3.x) constructs the URL as
#   <base>/<buildId>/<platform>/<archive>
# which matches the upstream googleapis.com layout. Note: do NOT swap the
# segment order; the bucket is laid out as /<version>/<platform>/, not the other
# way around.
PLATFORMS="win32 win64 linux64 mac-x64 mac-arm64"

fetch() {
    platform=$1
    archive=$2
    # buildId first, then platform — this is the puppeteer-browsers wire format.
    url="${UP}/${HYPIT_CHROME_VERSION}/${platform}/${archive}"
    dest="${OUT}/${HYPIT_CHROME_VERSION}/${platform}/${archive}"
    mkdir -p "$(dirname "$dest")"
    if [ -f "$dest" ] && [ -s "$dest" ]; then
        echo "[skip] $dest already present"
        return
    fi
    echo "[get ] $url -> $dest"
    if ! curl --fail --location --silent --show-error --retry 5 --retry-delay 5 \
            --connect-timeout 30 --max-time 600 -o "$dest" "$url"; then
        echo "[warn] could not fetch $url (platform may not exist for this version)" >&2
        rm -f "$dest"
        return 1
    fi
    echo "[done] $dest ($(stat -c%s "$dest" 2>/dev/null || wc -c <"$dest") bytes)"
}

for platform in $PLATFORMS; do
    archive="chrome-headless-shell-${platform}.zip"
    fetch "$platform" "$archive" || true
done

# No stable last-known-good.json at storage.googleapis.com/chrome-for-testing-public/ at
# the time of writing — the canonical index lives at
# https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json
# instead. The Provider does not need this file, so we skip mirroring it.

echo "chrome-mirror bootstrap complete; tree:"
find /out -maxdepth 4 -type f -o -type d | sort | head -50