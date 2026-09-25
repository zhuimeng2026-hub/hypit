#!/bin/bash
# CPU-only fallback build: concatenate the 10 spot B-rolls + outro,
# mux with the English narration, write the final video directly via
# ffmpeg. Skips the HyperFrames Chromium renderer entirely (which
# cannot finish frame 0 on this software-GPU host within the 180s
# protocol timeout). Use this to get a playable result now while the
# full Hypit build keeps retrying under crond.

set -e

PROJECT=/opt/hypit/examples/guizou-clone
BROLL=$PROJECT/assets/broll
NARR=$PROJECT/assets/narration.mp3
OUT=$PROJECT/output-cpu.mp4
WORK=$PROJECT/.tmp-cpu

rm -rf "$WORK"
mkdir -p "$WORK"

# Step 1: scale + trim each B-roll to 720x1280, no audio (we'll mux once).
echo "--- normalising B-roll to 720x1280 ---"
for n in 01-zhenshan 02-longli 03-guilan 04-zengchong 05-suoga-miao \
         06-shitouzhai 07-gaodang 08-jiacha 09-aile 10-shimenkan; do
  ffmpeg -y -loglevel error -i "$BROLL/spot-$n.mp4" \
    -vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2" \
    -an -c:v libx264 -preset fast -crf 22 "$WORK/$n.mp4"
done
ffmpeg -y -loglevel error -i "$BROLL/outro-city.mp4" \
  -vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2" \
  -an -c:v libx264 -preset fast -crf 22 "$WORK/outro.mp4"

# Step 2: build concat list (Demuxer format).
LIST=$WORK/list.txt
: > "$LIST"
for n in 01-zhenshan 02-longli 03-guilan 04-zengchong 05-suoga-miao \
         06-shitouzhai 07-gaodang 08-jiacha 09-aile 10-shimenkan outro; do
  printf "file '%s/%s.mp4'\n" "$WORK" "$n" >> "$LIST"
done

# Step 3: concat video.
echo "--- concat video ---"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$LIST" -c:v copy "$WORK/video.mp4"

# Step 4: mux narration on top (narration is shorter than video;
# remaining video plays silent in B-roll continuation).
echo "--- mux audio ---"
ffmpeg -y -loglevel warning -i "$WORK/video.mp4" -i "$NARR" \
  -map 0:v:0 -map 1:a:0 \
  -c:v copy -c:a aac -b:a 128k \
  -shortest -af "afade=t=in:st=0:d=0.2,afade=t=out:st=137.5:d=0.5" \
  "$OUT"

# Step 5: report
echo ""
echo "=== DONE: $OUT ==="
ffprobe -v error -show_entries format=duration,size,bit_rate -of default=noprint_wrappers=1 "$OUT"
ls -la "$OUT"