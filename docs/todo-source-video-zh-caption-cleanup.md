# TODO — source_video Chinese caption cleanup (carryover from 2026-09-26 session)

Date opened: 2026-09-26. Picked up by cron at 2026-09-27 01:00.

## Context

The user wants the hardcoded pink Chinese captions removed from
`/opt/hypit/source_video/guangzhou.mp4` (138.7s, 576×1024 portrait) before
muxing into the English dub.

Captions appear as pink/red text with sparkle emoji prefix
(`✨ 去广州深度游`, `✨ 6建议去圣心大教堂`, etc.). Their y position
varies wildly across the source — anywhere from y=550 to y=1000 of the
1024-tall frame. They come and go (not every frame has one).

## What was tried on 2026-09-26 (and why each failed)

All experiments are in `/tmp/clean_zh{1..8}.py` if you want to replay
them. The current detection pipeline lives at `/tmp/clean_zh8.py`.

| attempt | approach | result |
|---|---|---|
| v1 (`tesseract image_to_data --psm 11`) | OCR with chi_sim | too many false positives on signs/lamps; main text wasn't picked up reliably |
| v2 (`HSV pink band y>0.4*H, big dilation`) | pink hue mask | caught lanterns, signs, bokeh — not captions |
| v3 (`HSV pink band y>0.55*H, strict cw/ch>3`) | pink + shape filter | too strict: only 6/277 samples detected |
| v4 (`4 fps sampling, looser filter`) | pink + white stroke | wrong bbox on t=12 (caught building signs at y=775 instead of caption at y=990) |
| v5 (`y>700 only`) | bottom-only pink | same false-positive problem in mid-low region |
| v6 (`ffmpeg drawbox y=665..1024`) | brute force | blackens 35% of every frame — too aggressive, lost ground and feet |
| v7 (`bottom 200px + mid-frame detector`) | hybrid | mid-frame detector still picked wrong regions |
| v8 (`row-density peak finder`) | find peak horizontal text band | the detected bbox was usually correct BUT false-positives on lantern-rich frames make h grow to 100–500 px (eats b-roll) |

The fundamental problem: **the source has lots of legitimate pink/red content**
(red lanterns, neon signs, decorative building elements, Canton Tower's
lighting). HSV-based pink detection catches them all.

## Recommended next attempt (to run in cron at 01:00)

**Approach: Inpaint-based cleanup using OpenCV's `cv2.inpaint` on the pink+white mask**, then fall back to a thin static mask only where inpaint is unsure.

Pseudocode for the cron-bound script:

```python
# /tmp/clean_zh_cron.py — see actual script on disk
def detect_caption_bands(img):
    """Return list of (x, y, w, h) candidate caption bands."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    # Pink: very saturated, narrow hue band
    pink = cv2.inRange(hsv, (158, 130, 130), (180, 255, 255))
    # Pure white sparkle
    white = cv2.inRange(hsv, (0, 0, 230), (180, 50, 255))
    mask = cv2.bitwise_or(pink, white)
    # Hard morphological close to merge sparkle + glyphs (~30 px apart)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (31, 31))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    # Look only in lower 60% of frame
    band = np.zeros_like(mask)
    band[int(H*0.40):, :] = 255
    mask = cv2.bitwise_and(mask, band)
    # Filter to caption-shaped components
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        area = cv2.contourArea(c)
        # Caption: text-like density (filled ratio), wide aspect
        if 80 < w < W and 18 < h < 90 and w/h > 3.0 and area > 1500:
            boxes.append((x, y, w, h))
    return boxes

# Render:
#   1. For each frame, find caption boxes
#   2. Build mask, then cv2.inpaint(mask, inpaintRadius=15) to fill naturally
#   3. If inpaint result still has pinkish residuals (per HSV recheck), black-out instead
```

Why this might work where previous didn't:
- `MORPH_CLOSE` (instead of just dilate) fills small gaps between sparkle + glyphs
  without exploding the bbox size.
- `cv2.inpaint` fills the masked region with surrounding texture, so the
  caption disappears naturally without a black box.
- The aspect filter `w/h > 3.0` is more aggressive than before — caption is
  always a wide horizontal band, never a square block.

## Fallback if inpaint fails

If the cron run at 01:00 still produces black boxes (because the detector
finds wrong regions), use the brute-force `ffmpeg drawbox` approach as a
last resort:

```python
subprocess.run(['ffmpeg', '-y', '-i', SRC,
    '-vf', 'drawbox=x=0:y=820:w=576:h=204:color=black@1.0:t=fill',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', DST])
```

This blacks out the bottom 200px (y=820-1024) on every frame. Loss of
b-roll content at the bottom is acceptable — the captions at y=830-1020
are reliably hidden. Mid-frame captions (y=550-770) will leak through but
they're rare in this source.

## Cron entry

```
0 1 27 9 * /opt/hypit/source_video/run-cleanup-cron.sh
```

Already added via `crontab -e` on 2026-09-26 — verify with `crontab -l`.
Delete after the run completes.

## Acceptance criteria

1. `/opt/hypit/source_video/work/source.no-zh.mp4` exists, h264 576×1024, 138.7s,
   ~17 MB (or larger if inpaint preserves more pixels).
2. Sample frames at t = 12, 32, 62, 82, 102, 132 — none of them show any
   pink text in the bottom 50% of the frame.
3. B-roll quality: most frames still show the original scenery without
   black blobs. A few seconds with mid-frame captions leaking is acceptable.
4. After verification, re-mux the final dub:
   ```bash
   ffmpeg -i source.no-zh.mp4 -i mixed.v4.wav \
          -i captions.en.v4.ass \
          -map 0:v -map 1:a -map 2:s? \
          -c:v copy -c:a aac -b:a 128k \
          -c:s copy \
          guangzhou-en.mp4
   ```

## Related artifacts

- `/opt/hypit/source_video/work/guangzhou-en.mp4` — current English dub
  output (42 MB, has Chinese captions visible from source)
- `/opt/hypit/source_video/work/source.no-zh.mp4` — current best attempt
  at caption cleanup (170 MB, brute-force mpeg4, 25% black bars — needs
  replacement with proper h264)
- `/opt/hypit/source_video/work/captions.en.v4.ass` — final ASS with
  FontSize 24, max_chars 42, max_lines 3
- `/opt/hypit/source_video/work/mixed.v4.wav` — final TTS audio + bed
- `/tmp/clean_zh{1..8}.py` — all 8 detection attempts (kept for reference)