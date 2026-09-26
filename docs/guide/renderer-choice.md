---
title: Renderer Choice
description: Why Hypit's render path stays with HyperFrames; when a parallel renderer makes sense and what it must drop.
---

The Source describes the work. The Run chooses Targets. The **Renderer** turns the planned composition into frames and a final media file. This guide captures why the Renderer stays on HyperFrames today, what would be lost by replacing it with Remotion or any React-frame-driven library, and the shape that any incremental addition must take.

## Decision

The Renderer stays on HyperFrames. A wholesale migration to Remotion is not feasible: four load-bearing render contracts have no equivalent in `useCurrentFrame()` + `<AbsoluteFill>`. A **parallel** renderer is allowed; it must serve only the A+B feature subset and explicitly disable the four C-category primitives, because those primitives depend on the per-seek barrier that only HyperFrames provides.

## The current render path

`packages/hyperframes/src/document.ts:701-723` compiles a planned `Composition` into a single string of **vanilla DOM** HTML — one `<div data-composition-id>` root plus N `<div class="clip hypit-visual-present" data-start data-duration data-hypit-stack-order>` siblings, plus three small inline scripts:

- `frameAnimationRuntime` (`document.ts:620-660`) listens for `hf-seek` events, sets `animation.currentTime` on `animation-play-state: paused` CSS keyframes, samples `getComputedStyle`, **cancels** the animation, then writes the sampled properties as inline styles.
- `visibilityRuntime` (`document.ts:680-690`) handles sub-span opacity windows inside a Present.
- `browserProgramScript` (`packages/hyperframes/src/browser-program.ts:51-93`) calls the user's `(root, data) => render(localFrame)` escape hatch.

The local Renderer (`packages/provider-hyperframes-local/src/capture.ts:131-148`) runs N parallel Chrome Headless Shell workers (`152.0.7928.2`, pinned in `packages/provider-hyperframes-local/package.json:13`). Each frame: dispatch `hf-seek` → await `detail.waitUntil(fn): Promise` → `Page.captureScreenshot` PNG. The `waitUntil` barrier is the **pixel-level determinism contract**: font loading, joined-box measurement, and shrink-to-fit must complete before the frame is sampled. The text-flow runtime is the canonical place where `waitUntil` is registered today (`packages/hyperframes/src/text.ts:1169-1178`), gating `document.fonts.ready` and per-segment exact-font layout before the renderer is allowed to capture.

The Provider passes `forceScreenshot: true` deliberately to disable `@hyperframes/engine`'s BeginFrame fast path, because that path lacks the `waitUntil` barrier. Audio is a separate concern: `provider-media-local` runs ffmpeg amix, then `executeMuxProgramMedia` (`packages/media-execution/src/execute.ts:1234`) muxes a silent mp4 + a WAV into the final mp4.

## What Remotion actually offers (late 2026)

| Capability | Status | Notes |
| --- | --- | --- |
| React component → frame | yes | `useCurrentFrame()` + `<AbsoluteFill>` + `<Sequence>` |
| GSAP integration | yes | `@remotion/gsap` — paused timeline + `useCurrentFrame` seek; **forbidden**: `play/seek/onUpdate/Math.random()` |
| Lottie | yes | `@remotion/lottie` + `lottie-web` (open-source, no LottieFiles licence) |
| Three.js / R3F | yes | `@remotion/three`; must use `useCurrentFrame()`, not R3F's `useFrame()` |
| Captions + transcription | yes | `@remotion/captions` + whisper-cpp / elevenlabs / openai-whisper ingestion |
| CSS `@keyframes` | discouraged | Remotion docs explicitly warn flicker; only `useCurrentFrame`-driven content is supported |
| WAAPI | no | No first-party integration; not documented |
| Arbitrary HTML drop-in | no | `<IFrame>` is for static / `useCurrentFrame`-driven content; `<HtmlInCanvas>` is experimental, Chrome ≥ 149 |

Scaling: `@remotion/lambda` (1000 concurrent executions per region), local concurrency `CPU/2`, `npx remotion benchmark` to tune.

## Feature × compatibility classification

Four-bucket classification of the planned `Composition` features against a hypothetical React renderer:

| Class | Share | Meaning | Examples |
| --- | --- | --- | --- |
| **A** Maps cleanly | ~40% | Style-driven DOM with `useCurrentFrame()` + inline style | simple `<img>`/`<video>`/`<div>`, `<audio>` clip, visibility sub-spans, stacking order |
| **B** Needs adaptation | ~35% | Needs a `useEffect` wrapper, manual measurement, or seeded RNG | GSAP timeline for fine-caption motion / media edge-sustain-handoff, joined-box outline, shrink-to-fit, ellipsis line detection, path text upright rotation, per-word LCG sequence |
| **C** Incompatible | ~15% | The render contract is fundamentally different | per-seek barrier, paused CSS seek-and-cancel, `VisualProgramElement` user escape hatch, source-frame video slot injection |
| **D** Not in render path | ~10% | Generated as `BlobRef` upstream of the Renderer | image generation, TTS, whisperx alignment, `image-compose`, `image-transform`, `semantic-take-adjust` |

## The four C-category blockers

These four contracts are why a wholesale Remotion migration is not feasible. They are also what makes HyperFrames competitive against ffmpeg-only or pure-Lottie renderers.

### 1. `hf-seek` + `waitUntil(fn): Promise` per-frame barrier

`packages/hyperframes/src/text.ts:1169-1178` is the canonical implementation; the protocol is dispatched from the Renderer side per frame. The `hf-seek` event carries `detail.waitUntil(fn): Promise`; the screenshot is taken only after the promise resolves. Remotion's closest primitive is `delayRender()` / `continueRender()`, which is **one-shot per render**, not event-driven per seek.

### 2. Paused-CSS-keyframe seek + computed-style sampling + cancel + inline-style replay

`packages/hyperframes/src/document.ts:259-273` and `:620-660`. The runtime pauses CSS keyframe animations, seeks by `currentTime`, reads `getComputedStyle`, cancels the animation, then writes the sampled property values back as inline styles. This keeps seek deterministic and prevents compositor caching. `@remotion/gsap` does this **only for GSAP timelines**, not for arbitrary authored CSS keyframes. The Remotion docs explicitly warn that CSS animations flicker during render.

### 3. `VisualProgramElement` arbitrary `(root, data) => render(localFrame)`

`packages/hyperframes/src/browser-program.ts:51-93`. A user-authored escape hatch that runs an arbitrary function on a DOM root at every frame. There is no React equivalent unless the user re-authors the program as a React component. Translation rules for the escape hatch are not a renderer question — they are an authoring question.

### 4. Source-frame video slot injection with ffmpeg-pre-extracted PNGs

`packages/hyperframes/src/document.ts:381-407`, fed by `@hyperframes/engine`'s `FrameLookupTable`. For non-1:1 source/target rate mappings and held frames, the Renderer ffmpeg-decodes the source video into PNG sequences and the page renders a series of `<video data-hypit-source-rate="N/D" data-hypit-source-frame="M">` parts — one per loop boundary or held target frame. Remotion's `<OffthreadVideo>` plays a single source file; it cannot replicate "split one authored clip into N source-frame-rate pieces that each play a still PNG."

## Feasible incremental paths

### Path 1 — stay on HyperFrames (default)

The Renderer stays as-is. The four C-category primitives are the competitive differentiation against ffmpeg-only / Remotion / Lottie-only renderers; losing them is a downgrade. Recommended when no concrete pain point points at React.

### Path 2 — side-by-side `packages/render-remotion/`

Add a parallel Renderer that consumes a planned `Composition` and emits a React component tree. The Renderer is selected by `.svrun` `runtime: "remotion"`; the existing HyperFrames Renderer remains the default. Scope: 3–5 new packages, 2–4 person-months. C-category features are explicitly disabled for Remotion-run compositions; the validation layer (`packages/composition/src/track.ts:1392-1412` style assertions) emits a clear error when an unsupported feature is requested under `runtime: "remotion"`. Reuses `provider-media-local` for audio mux.

### Path 3 — Remotion for narrow deliverables

Use Remotion for static or template-shaped outputs (single stills, captioned clips without `VisualProgram` or non-1:1 rate mapping, template product videos). The Studio full-feature path stays on HyperFrames. ~1 person-month for a PoC.

## Licensing

Remotion is **not** MIT/OSS. Its license is custom and proprietary.

| Org type | License |
| --- | --- |
| Individuals, non-profits, companies ≤ 3 people | Free |
| Companies > 3 people (for-profit) | **Paid** — $25/seat·month (Creators) **or** $0.01/render with $100/month minimum (Automators); Enterprise $500+/month |

The Free License covers code that **the Hypit compiler generates** from a project's `.svml` / `.svrun` sources (LLM-generated code on behalf of users). It does **not** cover rendering user-supplied React components on behalf of users. Path 2 is therefore only compliant when the React tree is generated by the Hypit compiler, not when users upload `.tsx` to be rendered. Plan accordingly if `runtime: "remotion"` should accept authored `.tsx`.

## References

- `packages/hyperframes/src/document.ts:701-723` — composition HTML emission
- `packages/hyperframes/src/document.ts:259-273, 620-660` — paused-CSS seek + computed-style sampling + cancel + inline-style replay
- `packages/hyperframes/src/text.ts:1169-1178` — `hf-seek` listener with `waitUntil(fn): Promise` (per-frame barrier)
- `packages/hyperframes/src/browser-program.ts:51-93` — `VisualProgramElement` escape hatch
- `packages/provider-hyperframes-local/src/capture.ts:131-148` — Renderer driver loop
- `packages/provider-hyperframes-local/src/render.ts:76-128` — `renderHyperframesVisual` entry
- `packages/provider-hyperframes-local/package.json:13` — Chrome Headless Shell version pin
- `packages/media-execution/src/execute.ts:1234` — `executeMuxProgramMedia` (final mp4 mux)
- `packages/composition/src/track.ts:1392-1412` — composition validator (stacking-key collision)
- [Conventions](./conventions.md) — wire data and module boundaries
- [Runtime](./runtime.md) — selecting the Runtime Profile and Provider Endpoints
- [Models and Providers](./providers.md) — when a new Provider is the right change