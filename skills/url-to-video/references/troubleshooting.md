# Troubleshooting

Failures you are most likely to hit, and what to do.

## MiniMax returns no image or non-200

- Read `/opt/hypit/.env` — confirm `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_DEFAULT_MODEL`,
  `MINIMAX_TIMEOUT_SECONDS` are present.
- A non-200 with `status_code != 0` in `base_resp` means a business error (key rejected, model
  unavailable, quota exhausted). The error string is in `base_resp.status_msg`. Report it
  verbatim; do not retry.
- A timeout (curl exits 28) means the model is overloaded. One retry with `MINIMAX_TIMEOUT_SECONDS`
  bumped by 60 s is reasonable; two in a row is not — surface it.
- An empty `image_urls` array with `success_count: 0` is a content-policy reject. Tighten the
  prompt (remove brand names, people names, anything that could be a real entity) and retry
  once. If still empty, swap to a different camera angle and try again.

## Build fails: "Speech evidence requires normalized Take audio"

The SVML has segments that are not empty. Inspect `<script id="story">`:

- Wrong: `<spot-01-cantontower><HOST>...</HOST></spot-01-cantontower>` — has a token.
- Right: `<spot-01-cantontower/>` — empty.

Either strip the `<HOST>` children or remove the matching `<whisperx:SemanticTake language="...">`
attributes so the boundary fragment is selected.

## Build fails: "Unknown source export <name>"

The SVrun's `<target output>` does not match any `<id>.<port>` exposed by the SVML. The render
element's `id` and the target's `output` must agree.

## Build stuck at step 36/38 "rendering frames" for > 30 minutes

Chrome's software GPU renderer cannot finish HyperFrames on this host within the 180 s protocol
timeout. Symptom: a 720×1280 portrait render of ~4000 frames stays at < 5 % progress. Two
mitigations, in order:

1. Reduce per-spot `duration` from 12 s to 6 s — halves the frame count.
2. Switch to a CPU-only ffmpeg pipeline (`examples/guizou-clone/build-cpu.sh`) and skip
   HyperFrames entirely. This produces a concat-based video with no captions or component
   effects, but renders reliably.

## Image asset is over budget or shows characters despite `no text`

The MiniMax model treats generic storefront scenes as license to render plausible signage in
Chinese or English. The most reliable fix is to change the camera angle, not the prompt.
Examples:

- A night street scene that keeps generating neon Chinese → switch to a daytime wide stone-paved
  pedestrian street with no overhead signage.
- A skyscraper that keeps generating rooftop brand text → tilt up so the frame is sky + spire
  only, no rooftop letters.
- A plaza or gate that keeps generating horizontal banner text → redraw as a top-down archaeological
  close-up (paving layers, ornamental roof ridge sculptures).

If a single angle change does not solve it, accept the regeneration cost — three retries per
spot is the budget before re-framing.

## Cron did not run

`/usr/sbin/cron -f -P` must be running (`ps aux | grep cron`). Files in `/etc/cron.d/` need
`chmod 644` and an empty line at the end (cron parses them strictly). Verify with
`run-parts --test /etc/cron.d/` — if it lists your file, cron will pick it up on the next
minute boundary.