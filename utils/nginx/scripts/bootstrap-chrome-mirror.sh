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

# chrome-headless-shell exists per platform under <platform>/<build-id>/<archive>.
PLATFORMS="win32 win64 linux64 mac-x64 mac-arm64"

fetch() {
    platform=$1
    archive=$2
    url="${UP}/${platform}/${HYPIT_CHROME_VERSION}/${archive}"
    dest="${OUT}/${platform}/${HYPIT_CHROME_VERSION}/${archive}"
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

# last-known-good.json helps browsers verify the current stable version; mirror it too.
lkg="${UP}/last-known-good.json"
if curl --fail --location --silent --show-error --retry 3 --retry-delay 5 \
        --connect-timeout 30 --max-time 60 -o "${OUT}/last-known-good.json" "$lkg"; then
    echo "[done] ${OUT}/last-known-good.json"
else
    echo "[warn] could not fetch ${lkg}; not fatal" >&2
fi

echo "chrome-mirror bootstrap complete; tree:"
find /out -maxdepth 3 -type f -o -type d | sort | head -50