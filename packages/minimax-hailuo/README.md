# `@hypit/minimax-hailuo`

The exact MiniMax `MiniMax-Hailuo-2.3` video model, declared for the Markup Frontend.

Like every Model package this owns **what the model accepts**, never **how it is
called**. The wire names, the HTTP paths and the credential belong to
`@hypit/provider-minimax`; the two meet only at the capability string
`@hypit/minimax-hailuo@1#hailuo-i2v`.

## Why this is a separate package from `@hypit/minimax-h3`

The two models genuinely disagree about their parameter surface. Every value here
was read back from the live endpoint's own validation messages, using the fact
that **MiniMax validates a request before it checks quota** — a field it
recognises rejects a wrongly-typed value with `2013`, while a field it does not
know passes through to the quota check. That difference is what identifies it.

| Field | Hailuo-2.3 | `minimax-h3` |
|---|---|---|
| `duration` | **6s or 10s only** | 4–15s |
| `resolution` | **768P or 1080P** | 768P or **2K** |
| `aspectRatio` | **not accepted** | accepted |
| `referenceImage/Video/Audio` | **not accepted** | accepted |
| `firstFrame` / `lastFrame` | accepted | accepted |
| `subject_reference` | field exists, but this model answers `does not support Subject-Reference-Video mode` | — |

Merging them would force one of the two to send fields the service ignores or
rejects, so they stay separate. `minimax-h3` already has Providers serving it.

## Ports

| Port | Vocabulary |
|---|---|
| `prompt` | text, max 7000 chars |
| `duration` | 6 or 10 seconds |
| `resolution` | `768P` or `1080P` |
| `firstFrame` / `lastFrame` | up to one image each |
| `promptOptimizer` | boolean |

One combination the service rejects outright — `duration 10s` with
`resolution 1080P` — cannot be expressed by a port table, so
`verifyHailuoI2vRequest` refuses it before any Endpoint is selected.

## Authoring

```xml
<import as="hailuo" from="@hypit/minimax-hailuo@1"/>

<text:Value id="motion">A boy glides slowly forward, wings beating gently…</text:Value>
<hailuo:FrameVideo id="glide" prompt={motion}
  duration="6" resolution="1080P" prompt-optimizer="true"
  first-frame={still.image}/>
```

The element publishes `<id>.video`, an ordinary Blob that a `visual:Clip` places
like any other footage. Text-to-video without a frame is `<hailuo:TextVideo>`.

Neither Surface copies runtime media into request metadata: the prompt and every
frame stay explicit graph edges, so the Provider reads the Artifact at execution
time and the Build records where it came from.

## Selecting a Provider

This package declares the model; a Runtime Profile must also name the Endpoint
that serves `@hypit/minimax-hailuo@1#hailuo-i2v`. See `@hypit/provider-minimax`,
which reaches the native service and any gateway that relays the same paths
through one configurable `baseUrl`.