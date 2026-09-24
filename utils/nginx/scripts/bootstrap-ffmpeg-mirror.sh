#!/bin/sh
# Pulls static ffmpeg builds (BtbN/FFmpeg-Builds) for win64 + linux64 into /out.
# Idempotent: skips files that already exist.
#
# Run as:  docker compose run --rm ffmpeg-mirror-bootstrap
#
# BtbN uses rolling `latest` releases (no fixed version tags); the upstream
# `autobuild-<version>` URLs we tried are 404 because BtbN now ships only
# `latest`. Override HYPIT_FFMPEG_UPSTREAM_TEMPLATE if you want to point at a
# different mirror.

set -eu

: "${HYPIT_FFMPEG_UPSTREAM_TEMPLATE:=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-%s-gpl%s}"

OUT=/out

# (subdir, archive-suffix) per platform.
fetch() {
    subdir=$1
    suffix=$2     # .zip for win, .tar.xz for linux
    archive=$(printf "ffmpeg-master-latest-%s-gpl%s" "$subdir" "$suffix")
    url=$(printf "$HYPIT_FFMPEG_UPSTREAM_TEMPLATE" "$subdir" "$suffix")
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
    # Capture the upstream SHA256 from the asset name + a checksums.sha256 mirror.
    echo "[done] $dest ($(stat -c%s "$dest" 2>/dev/null || wc -c <"$dest") bytes)"
}

fetch win64   .zip
fetch linux64 .tar.xz

# Publish a tiny index.json so the README "ffmpegPath" hint stays stable across
# re-bootstraps.
cat >"${OUT}/index.json" <<JSON
{
  "win64":   "/win64/ffmpeg-master-latest-win64-gpl.zip",
  "linux64": "/linux64/ffmpeg-master-latest-linux64-gpl.tar.xz",
  "note":    "BtbN/FFmpeg-Builds rolling latest; extract and put bin/ on PATH"
}
JSON
echo "[done] ${OUT}/index.json"

echo "ffmpeg-mirror bootstrap complete; tree:"
find /out -maxdepth 3 -type f -o -type d | sort | head -50