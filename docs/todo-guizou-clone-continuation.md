# TODO — Hypit × guizou-clone continuation

Date opened: 2026-09-26 (carryover from 2026-09-25 session).
See `docs/guizou-clone-status-2026-09-25.md` for the full state snapshot.

## 1. [ ] Check crond run result

After 01:00, look at:
  - `/tmp/guizou-cron-build.log` — the crond wrapper output
  - `/tmp/guizou-cron-inspect.log` — the post-build `hypit inspect` summary

Decision tree:
  - ✅ Build succeeded → the protocolTimeout fix may not even be needed; jump
    straight to item 4 (visual layer in listicle-video.py)
  - ❌ Still failing on frame 0 → proceed to item 2

## 2. [ ] Add `protocolTimeout` exposure to `provider-hyperframes-local`

This is the cheapest fix for the Chrome `Runtime.callFunctionOn timed out`
failure that has been blocking every Hypit build.

Touch points:
  - `packages/provider-hyperframes-local/src/options.ts` — add
    `readonly protocolTimeoutMs?: number` to the options interface
  - `packages/provider-hyperframes-local/src/activation.ts` — accept it as
    a runtime config field, validate, pass through to render options
  - `packages/provider-hyperframes-local/src/render.ts` — forward into the
    `engine.createCaptureSession(..., browserOptions)` call at capture.ts:172

Expected: ~10–20 lines of source change. Add to the existing
`hypit.runtime.json` example:
  ```json
  "hyperframes.local": {
    "config": { ..., "protocolTimeoutMs": 600000 }
  }
  ```

## 3. [ ] Probe MiniMax `hailuo-2.3` directly

Constraint from 2026-09-25: **MiniMax direct only, no Kapon**.

Endpoint to probe (per `docs/minimax-call.md` and
`/opt/OpenMontage_Voicebox/tools/video/minimax_video.py`):

  ```
  POST https://api.minimaxi.com/v1/video_generation
  Authorization: Bearer $MINIMAX_API_KEY
  Content-Type: application/json
  {
    "model": "hailuo-2.3-fast/standard",   // or "hailuo-2.3-fast/pro"
    "prompt": "test clip, 6s, golden ginkgo tree, stone bridge",
    "duration": 6,
    "resolution": "768P"
  }
  ```

Expected: ~$0.08, ~30s wall-clock. Confirms:
  - the `MINIMAX_API_KEY` still has hailuo-2.3 quota (avoid the 2067 trap)
  - the safety layer does not over-soften a clean ginkgo/bridge prompt
  - the JSON response shape is what OM's tool already handles
    (sync URL list under `data.video_urls`)

If green: this is the A-roll material for tomorrow's full clone.
If quota-exhausted (2067): fall back to B-roll-only rebuild with
just better English overlays.

## 4. [ ] Decide the visual layer path

Two viable paths once the technical block is gone:

  **(a) Hypit full path.** Re-run the SVML build after step 2 — HyperFrames
      should now survive frame 0, the protocol layer holds for the slower
      software-GPU render. May still take many hours per frame; budget
      ~3 days wall-clock for the full 720x1280/30fps render.

  **(b) `listicle-video.py` visual layer.** Extend the standalone script
      with ffmpeg `drawtext` (for English captions burned into each spot)
      and `overlay` (to composite `presenter-minimax.png` on the cover
      frame). Still CPU-only, ~minutes per run, no browser dependency.
      Visual quality is "good enough" — presenter becomes a static PNG
      overlay rather than a true talking head.

Recommend (b) for the first cut; revisit (a) only if (b) is unsatisfying.

## 5. [ ] Cleanup pass

Once one of the above paths ships a video:
  - Delete `/opt/hypit/examples/guizou-clone/.tmp-cpu/` (if `--keep-tmp`
    was used)
  - Decide whether to commit `output-cpu.mp4` (200 MB) to git or keep it
    gitignored; current `.gitignore` excludes it — fine
  - Remove the crontab entry `0 1 26 9 *` once not needed (it is
    already past-date)

## 6. [ ] Memory / docs

  - If `provider-hyperframes-local` is patched: bump the package version
    and reference the new `protocolTimeoutMs` knob in
    `docs/guide/providers.md`
  - If hl2.3 is wired into a Hypit provider: document the
    `hailuo-2.3` model name + endpoint + 2067 caveat somewhere
    consistent (probably `docs/guide/service-partners.md`)