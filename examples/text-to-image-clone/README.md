# `text-to-image-clone` — generating stills *inside* the Build

The seam this example covers: a picture is produced by a text-to-image model
**during the Build**, feeds `<pipeline:Still>`, and the whole video renders
from stills — with **no video-generation model anywhere in the Profile**.

```
<mi:TextImage> ──MiniMax image-01──▶ Blob (.image)
      └─▶ <pipeline:StillVideo> ─▶ <pipeline:Normalize> ─▶ <visual-track:Clip>
              ─▶ <film:Film> ─▶ <html:Video> ─▶ Chromium + ffmpeg ─▶ MP4
```

Verified end to end on 2026-10-13: 720×1280, 30 fps, 1680 frames, 56.0 s,
h264 + aac. Spot 1 of the output is the generated picture.

## Why it exists

Both halves already existed separately, which is why this gap was easy to miss:

| Example | In-graph image gen | Renders from stills only |
|---|---|---|
| `gz-exbi-en`, `guangzhou-clone` | ❌ out-of-band `gen-images.sh` curl → `asset:Image` | ✅ |
| `ranking-football`, `podcast`, `interview` | ✅ `<gpt:Image>` + provider-hypihub | ❌ every one also mounts seedance video nodes |

The two idioms sit side by side here on purpose — spot 1 is in-graph, spots
2–8 are checked-in JPEGs. Swap any one of them independently.

## The two idioms

**Out-of-band** (what `gz-exbi-en` does) — cheap, idempotent, re-runnable
without spending image-API money:

```xml
<asset:Image id="spot-02" src="./assets/broll/spot-02.jpg"/>
```

**In-graph** (what this example adds) — the picture becomes a graph edge, so
the Build records where it came from and the Provider owns the request:

```xml
<text:Value id="shot-01-prompt">Vertical cinematic travel photograph of …</text:Value>
<mi:TextImage id="shot-01" prompt={shot-01-prompt}
  aspect-ratio="9:16" n="1" response-format="url" prompt-optimizer="true"/>
<pipeline:StillVideo id="broll-01-video" duration="210f" clock={clock}>
  <pipeline:Still source={shot-01.image}/>
</pipeline:StillVideo>
```

`<id>.image` is an ordinary Blob, so `<pipeline:Still>` takes it exactly as it
takes an `<asset:Image>` — nothing intermediate touches disk. `aspect-ratio`
must match the canvas (9:16 here), not the intended crop.

## Wiring

`hypit.runtime.json` — four endpoints, and **none of them generates video**:

```json
"minimax.local": {
  "use": "@hypit/provider-minimax",
  "config": {
    "baseUrl": "https://api.minimaxi.com",
    "apiKey": { "store": "env", "key": "MINIMAX_API_KEY" },
    "defaultConcurrency": 2
  }
}
```

`MINIMAX_DEFAULT_MODEL=image-01` already equals the Provider's default wire
model name, so no `models` override is needed. The credential comes from
`@hypit/credential-store-env`, so export it before building.

## Running it

```bash
set -a && . /opt/hypit/.env && set +a   # MINIMAX_API_KEY
node /opt/hypit/bin/hypit.mjs runtime up --runtime ./hypit.runtime.json --project .
node /opt/hypit/bin/hypit.mjs plan text-to-image.svrun
node /opt/hypit/bin/hypit.mjs build text-to-image.svrun \
  --runtime ./hypit.runtime.json --project . --follow
node /opt/hypit/bin/hypit.mjs get <build-id> --output text-to-image-final.video --to ./out/
```

Wall clock is ~4–5 min for 56 s of 720×1280, and nearly all of it is the
Chromium raster pass, not the image request.

## Caveats

- **Requires the uncommitted `@hypit/minimax-image` / `@hypit/provider-minimax`
  packages.** They are wired into `packages/video/package.json` but not yet in
  git history, so a fresh clone cannot run this example yet.
- Requires the MiniMax native API shape (`/v1/image_generation`,
  `/v1/video_generation`). A gateway relaying those paths unchanged needs only
  a different `baseUrl`, model name and key.
- Narration here is a pre-generated edge-tts mp3 — no speech model is
  configured, deliberately, to keep this example about the image path.
