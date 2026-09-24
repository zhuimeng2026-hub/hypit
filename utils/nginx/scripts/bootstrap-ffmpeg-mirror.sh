#!/bin/sh
# Pulls static ffmpeg builds (BtbN/FFmpeg-Builds) for win64 + linux64 + mac into /out.
# Idempotent: skips files that already exist.
#
# Run as:  docker compose run --rm ffmpeg-mirror-bootstrap
#
# Override via env: HYPIT_FFMPEG_VERSION (e.g. 7.1.1), HYPIT_FFMPEG_UPSTREAM
# (default https://github.com/BtbN/FFmpeg-Builds/releases/download/).

set -eu

: "${HYPIT_FFMPEG_VERSION:=7.1.1}"
: "${HYPIT_FFMPEG_UPSTREAM:=https://github.com/BtbN/FFmpeg-Builds/releases/download}"

OUT=/out
UP="${HYPIT_FFMPEG_UPSTREAM%/}"

# (subdir, archive) per platform. linux64 uses .tar.xz; win64 uses .zip; macos uses .7z
# (kept simple here — we mirror only win64 + linux64 by default; mac users can grab from
# upstream directly).
fetch() {
    subdir=$1
    archive=$2
    url="${UP}/autobuild-${subdir}-${HYPIT_FFMPEG_VERSION}/latest/${archive}"
    dest="${OUT}/${subdir}/${archive}"
    mkdir -p "$(dirname "$dest")"
    if [ -f "$dest" ] && [ -s "$dest" ]; then
        echo "[skip] $dest already present"
        return
    fi
    echo "[get ] $url -> $dest"
    if ! curl --fail --location --silent --show-error --retry 5 --retry-delay 5 \
            --connect-timeout 30 --max-time 1800 -o "$dest" "$url"; then
        echo "[warn] could not fetch $url; not fatal" >&2
        rm -f "$dest"
        return 1
    fi
    echo "[done] $dest"
}

fetch win64      "ffmpeg-${HYPIT_FFMPEG_VERSION}-win64-gpl.zip"
fetch win64      "ffmpeg-${HYPIT_FFMPEG_VERSION}-win64-gpl.txt"
fetch linux64    "ffmpeg-${HYPIT_FFMPEG_VERSION}-linux64-gpl.tar.xz"

# Publish a tiny index.json so a Provider config can reference a stable URL without
# hardcoding the version in two places.
cat >"${OUT}/index.json" <<JSON
{
  "version": "${HYPIT_FFMPEG_VERSION}",
  "win64":   "/win64/ffmpeg-${HYPIT_FFMPEG_VERSION}-win64-gpl.zip",
  "linux64": "/linux64/ffmpeg-${HYPIT_FFMPEG_VERSION}-linux64-gpl.tar.xz"
}
JSON
echo "[done] ${OUT}/index.json"

echo "ffmpeg-mirror bootstrap complete; tree:"
find /out -maxdepth 3 -type f -o -type d | sort | head -50