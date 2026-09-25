# Conventions

The defaults below are tied to the `references/scripts/gen-images.py` and
`references/scripts/gen-tts.sh` helpers. Change a default only if you also update the helpers
and `BRIEF.md`.

## Asset filenames

- `assets/narration.mp3` — one continuous mp3, English by default.
- `assets/broll/spot-NN-<slug>.jpg` — exactly one image per segment, two-digit zero-padded index.
- `assets/broll/outro-<slug>.jpg` — the closing image; same dimensions as the spots.

Filenames are referenced literally from the SVML. Renaming the file means editing the SVML.

## Output artifact key

The render element's `id` and the SVrun's `<target output>` **must share a project slug** so
concurrent runs in shared storage do not collide. Pattern: `<project-slug>-final.video`.

- Wrong: `id="final"`, `<target output="final.video"/>` — collides with `examples/guizou-clone/`.
- Right: `id="url-to-video-final"`, `<target output="url-to-video-final.video"/>`.

The export step then uses the same key:

```
hypit get <build-id> --output url-to-video-final.video --to <output-path>
```

## Prompt rules

- Always end with `cinematic travel photography, no text, no watermark, vertical 9:16`.
- For shots that historically attract text (storefronts, signs, neon, plaques), append an extra
  `no signage, no Chinese characters, no English letters, no numbers, no logos` clause and
  set `prompt_optimizer: false` in the JSON body.
- If a generated image still contains text, regenerate. Up to 3 attempts per spot; beyond that,
  switch the camera angle (e.g. flip to a top-down archaeological close-up for a street scene)
  rather than rephrasing the same prompt.

## Empty-segment rule

`<script>` segments must be **truly empty** (self-closing or with no token children) for the
`whisperXBoundarySemanticTakeFragment` to be selected. Any token — even a single `<HOST>` —
forces the full fragment, which requires speech-evidence audio from each segment's prepared
media. Static-image prepared media has no audio, so the build fails with `Speech evidence
requires normalized Take audio`. The original `examples/guizou-clone/guizou.svml` is the
canonical example of this mistake.

## Output naming

The user may request `<output-name>.video.mp4`. If they don't, derive one from the URL or the
brief slug. Always emit at least `<output-name>.video.mp4`; do not also write
`final.video.mp4` or other legacy names — they collide with sibling projects.

## Cron / scheduling

Do not install a system cron unless the user explicitly asks for recurring rebuilds. If they
do, use the wrapper pattern from `examples/guangzhou-clone/cron-rebuild.sh`:
- one `$TS=$(date +%Y%m%d-%H%M%S)` at the top of the script,
- the same timestamp reused for the log file, the build title, and the export path,
- `--output <project-slug>-final.video` matching the SVrun target.