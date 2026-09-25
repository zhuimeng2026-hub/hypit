---
name: url-to-video
description: Convert a source URL — reference video, social-media post, GitHub PR with media, public web page, blog article, or any fetchable artifact — into a new target video file via the Hypit SVML pipeline. Defaults: MiniMax text-to-image (`MINIMAX_*` env) for still B-roll, edge-tts for English narration, empty-segment `whisperx:SemanticTake` pattern, 720×1280 portrait canvas, parallel image generation. Use when the user asks for a video *based on* something reachable at a URL, and they have not asked for the deep creative direction the `hypit` skill provides.
---

# url-to-video

You are the orchestrator for a single recurring job: take a URL the user supplies, derive a coherent
video from it, and emit a finished file. Stay close to the default pipeline; defer deep creative
direction, scene craft, and authoring depth to the `hypit` skill — load it when the URL demands
reading, frame analysis, or a faithful adaptation of a real reference work.

## When to use this skill

- The user gives you **one URL** (or a short list) and asks for a video about it.
- The deliverable is a finished file, not a project walkthrough.
- The source is reachable through `curl`, `yt-dlp`, `gh`, the browser tool, or `WebFetch`.
- Local/generated assets are acceptable defaults (text-to-image, edge-tts) and the user has not
  requested a specific provider.

If the user asks for a faithful recreation, a long-form adaptation, an interactive Studio session,
or multi-track mixing, hand off to `hypit` and stop reading this file.

## Inputs the user must supply

1. **The source URL.** Any of:
   - A video file URL (mp4 / mov / m3u8) → fetch via `yt-dlp` or direct `curl`.
   - A web page URL → `WebFetch` for the prose; the browser tool if visual capture is needed.
   - A GitHub PR / issue URL → `gh pr view <url> --json title,body,files` for context.
   - A social-media post URL → `WebFetch` and follow the canonical link inside.
2. **The output filename or path.** If absent, default to
   `<project>/<output-name>.video.mp4` where `output-name` is a slug of the URL or brief.
3. **Optional overrides** (any of):
   - target duration (default 132 s = 11 × 12 s segments),
   - aspect ratio (default 9:16 portrait),
   - language for narration (default `en`),
   - voice for narration (default `en-US-GuyNeural`),
   - list of spots if the user wants explicit ones.

If the URL is missing, ask once. If the filename is missing, derive one from the URL and continue.

## Conventions you must follow

These are the defaults the script-side tooling in `references/default-pipeline.md` and the helper
scripts in `references/scripts/` rely on. Do not silently change them — if a different value is
required, document the override in `BRIEF.md`.

| Concern | Default | Source of truth |
| --- | --- | --- |
| Image generation | MiniMax `image-01`, 9:16 | `/opt/hypit/.env` → `MINIMAX_*` |
| Voice | edge-tts `en-US-GuyNeural --rate=-30%` | `references/scripts/gen-tts.sh` |
| Image concurrency | 3-way parallel | `references/scripts/gen-images.py` |
| Per-spot duration | 12 s (× 11 segments ≈ 132 s) | `references/default-pipeline.md` |
| Empty-segment pattern | `<spot-x/>` (no `<HOST>` token) so `whisperx:SemanticTake` selects the boundary fragment | same |
| Canvas | 720×1280 portrait | `references/default-pipeline.md` |
| Output artifact key | `<project-slug>-final.video` | `references/conventions.md` |
| Cron-style rebuild | `/etc/cron.d/url-to-video` is *not* installed by default; only set it up if the user asks for recurring rebuilds | — |

## Workflow

Follow these steps in order. Each step's "exit condition" tells you when to move on.

### 1. Resolve the URL
- Identify the URL type (video / page / PR / social post / image).
- Fetch the canonical content. Prefer `yt-dlp` for video, `WebFetch` for prose, `gh` for PRs,
  the browser tool only if a visual capture is genuinely needed.
- Save raw material under `<project>/source-refs/` (gitignored). **Do not** commit it.

**Exit condition:** the source content is on disk and you can describe in one sentence what it is.

### 2. Analyze and brief
- For a video: extract frames at ~1 fps, read the audio with `whisperx` or `edge-tts --list-voices`
  if alignment matters, jot the hook/payoff in plain language.
- For prose: extract the headline, the three to five core beats, and any concrete visual subjects
  (places, objects, people).
- Write `<project>/BRIEF.md` capturing:
  - the source URL,
  - the user's stated outcome,
  - the spots or beats the new video must cover,
  - what is intentionally different from the source (replacements, removals, style),
  - any explicit constraints (duration, language, brand material).

**Exit condition:** `BRIEF.md` lists ≥ 3 concrete spots, each one a single sentence with a noun
phrase a text-to-image prompt can target.

### 3. Generate assets
- Run `references/scripts/gen-images.py` (or its inline equivalent) with one prompt per spot.
  Each prompt is a single sentence, ends with `cinematic travel photography, no text, no watermark,
  vertical 9:16`, and names the subject concretely. Use `--prompt-optimizer false` for any spot
  the model decorates with text (storefronts, signage, shops) and re-render until the image has
  no readable characters.
- Run `references/scripts/gen-tts.sh` (or its inline equivalent) for the narration mp3. Match the
  target duration to within ~5 s; if it drifts, slow or speed `--rate` accordingly.
- Hash both files into `BRIEF.md` so a later run can detect drift.

**Exit condition:** one `.jpg` per spot, one `narration.mp3`, no readable text in any image.

### 4. Author SVML / SVS / SVRun
- Use the empty-segment pattern from `references/default-pipeline.md`. Each `<spot-x/>` is
  self-closing; the `<whisperx:SemanticTake>` for it omits `language` so the boundary fragment
  is selected automatically.
- Render the final composition via `<render:Video id="<project-slug>-final">` so the artifact
  key does not collide with the `hypit` skill's `final.video`.
- `<svrun>` targets that artifact key.

**Exit condition:** `hypit check <svml>` returns `✓ Source is valid` and
`hypit check <svrun>` returns `Targets: <project-slug>-final.video`.

### 5. Build, wait, export
- Submit `hypit build <svrun> --runtime <hypit.runtime.json> --title "<title>" --json`.
- Poll `hypit activity` or `hypit status <build-id>` until the state is `complete`, `failed`,
  `cancelled`, or `errored`. Cap waiting at 30 minutes.
- On `complete`: `hypit get <build-id> --output <project-slug>-final.video --to <output-path>`.
- On any other terminal state: report the failure verbatim from `hypit logs <build-id>` and stop.

**Exit condition:** the requested `<output-path>` file exists, ffprobe reads duration and
codec, and `hypit inspect <build-id>` shows `Outcome complete` with the right target.

### 6. Report
Speak aloud what was made: source URL, spot list, output path, file size, duration. If any
prompt had to be re-generated to scrub text, say so — do not silently hide retries.

## Stop conditions

Stop and tell the user if any of these are true:

- The URL is unreachable after two attempts with different tools.
- MiniMax returns a non-200 or empty `image_urls` array — the API key in `/opt/hypit/.env` may
  be expired or rate-limited; do not retry silently.
- The build fails for a reason that is not a known text-scrub retry (see `references/troubleshooting.md`).
- The user asks a question that has nothing to do with this pipeline — the `hypit` skill covers
  the deeper work.

## What this skill deliberately does not do

- Author components, prompt kits, or models. If the user needs new packages, hand off to `hypit`.
- Run on a hosted Runtime. The default is the local Runtime Profile already used by the project's
  `hypit.runtime.json`.
- Handle interactive Studio sessions. Use the `studio` command directly, not this skill.
- Replace the `hypit` skill for deep creative direction. This skill assumes the user wants a
  video, not a conversation about video.