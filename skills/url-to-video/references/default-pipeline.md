# Default pipeline

The pipeline this skill runs by default is the same one used by `examples/guangzhou-clone/`.
If the user overrides anything (duration, aspect, voice, image model), record the override in
`BRIEF.md` and adjust — but keep the structural skeleton.

## Project shape

```
<project>/
├── BRIEF.md                 # source URL, spots, overrides
├── source-refs/             # raw fetched material (gitignored)
│   └── <downloaded-files>
├── assets/
│   ├── narration.mp3        # one continuous mp3 from edge-tts
│   └── broll/
│       ├── spot-01-<slug>.jpg
│       ├── spot-02-<slug>.jpg
│       ├── ... (one per spot)
│       └── outro-<slug>.jpg
├── gen-images.py            # or .sh — MiniMax parallel generator
├── gen-tts.sh               # edge-tts wrapper
├── guangzhou-style.svml     # or whatever name; SVML body
├── guangzhou-style.svs      # full-bleed cover recipes
├── guangzhou-style.svrun    # targets the <slug>-final.video
├── hypit.runtime.json       # local Runtime Profile
└── package.json             # project manifest
```

`<slug>` is `url-to-video` when the skill runs without a project name override, or a short
slug the user supplies.

## SVML skeleton

The SVML body must contain exactly one each of:

- `<program:Clock id="clock" frame-rate="30"/>` — 30 fps throughout.
- `<asset:Audio id="narration" src="./assets/narration.mp3"/>` plus a
  `<pipeline:Normalize id="narration-media" source={narration} video="none" audio="default"
   span-authority="audio" clock={clock}/>` so the audio stream is on the project clock.
- For each spot `<i>`:
  - `<asset:Image id="broll-<i>-<slug>" src="./assets/broll/spot-<i>-<slug>.jpg"/>`
  - `<pipeline:StillVideo id="broll-<i>-video" duration="12" clock={clock}>` with one
    `<pipeline:Still source={broll-<i>-<slug>}/>` child. Duration is per-segment; the
    total video length is `(n_spots + 1) × per_segment_duration` including the outro.
  - `<pipeline:Normalize id="broll-<i>-media" source={broll-<i>-video.video}
     video="primary-moving" audio="none" span-authority="video" clock={clock}/>`.
- A `<script id="story">` containing one truly empty segment per spot, e.g.
  `<spot-01-cantontower/>`. Empty segments (no `<HOST>` token) make the whisperx decoder
  pick the `whisperXBoundarySemanticTakeFragment` automatically — see `conventions.md`.
- One `<whisperx:SemanticTake>` per spot referencing the matching empty segment, **without**
  the `language` attribute. The boundary fragment needs no speech-evidence audio.
- A `<time:Timeline>` of `<time:Take>` children in performance order.
- A `<space:Canvas width="720" height="1280">` for portrait 9:16.
- A `<media-track:Track>` with one `<media-track:Item>` per spot bound to
  `story.segment.<slug>` and the matching `broll-<i>-media.media`.
- A single `<audio-track:Track>` with one `<audio-track:Item>` covering `during="program"`
  with `playback="once-start"`, `fade-in="200ms"`, `fade-out="500ms"`.
- A `<film:Film>` referencing both tracks and a `<render:Video>` whose `id` is the
  project-slug-prefixed artifact key (e.g. `id="url-to-video-final"`).

## SVS skeleton

At minimum a `media.cover` recipe:

```
media.cover {
  stack-order: 10;
  fit: cover;
}
```

Add `media.cover-2` ... `media.cover-N` (one per spot) with increasing `stack-order` values
if you need per-item layering, or keep them all on the single `media.cover` recipe.

A `film.vertical` recipe with `background: #000000` is also useful.

## SVRun

```
<?svml using="@hypit/run-markup@1"?>
<svrun version="1">
  <author source="./<svml-name>.svml"/>
  <target output="<project-slug>-final.video"/>
</svrun>
```

The target's `output` value **must** match the render element's `id.video` port.

## Timing

| Knob | Default | Effect |
| --- | --- | --- |
| `frame-rate` | 30 | stays at 30 fps |
| `duration` (per StillVideo) | 12 s | total ≈ `(spots + 1) × 12` s |
| Total narration | matches total video ± 5 s | tune `--rate` to fit |
| Audio fade | 200 ms in / 500 ms out | audio fades to silence at the end |