# `@hypit/minimax-image`

The exact MiniMax `image-01` image model, declared for the Markup Frontend.

This package owns **what `image-01` accepts**, never **how it is called**. The
wire names, the HTTP endpoint and the credential belong to a Provider package;
the two meet only at the capability string `@hypit/minimax-image@1#image-01`.
A Model is therefore reusable by any Provider that can serve that capability,
and a Provider never imports a Model.

## Ports

Every value was read back from the live endpoint's own validation messages
rather than assumed:

| Port | Vocabulary | Source of truth |
|---|---|---|
| `prompt` | text, max 3000 chars | `prompt are required` |
| `aspectRatio` | `1:1` `16:9` `4:3` `3:2` `2:3` `3:4` `9:16` `21:9` | `must be one of [...]` |
| `n` | integer 1–9 | `must be between 1 and 9` |
| `responseFormat` | `url` `base64` | `not 'url' or 'base64'` |
| `promptOptimizer` | boolean | service boolean |
| `subjectReference` | up to 10 images, item field `type` = `character` | `must be character` |

Note that `responseFormat` values are `url` and `base64` — **not** `b64_json`,
which is the spelling OpenAI-style services use for the same idea. A Provider
translates; an author writes `response-format="base64"` and never sees the wire.

`subjectReference` declares only the `character` role because that is the only
role the model currently accepts. Widening the vocabulary here would let `plan`
accept a request the model cannot honour.

## Authoring

```xml
<import as="mi" from="@hypit/minimax-image@1"/>

<text:Value id="scene-prompt">A wide establishing shot at dusk…</text:Value>
<mi:TextImage id="scene" prompt={scene-prompt}
  aspect-ratio="16:9" n="1" response-format="url" prompt-optimizer="false"/>
```

The element publishes `<id>.image`, an ordinary Blob that a `visual:Clip` places
like any other picture.

Character references use the second Surface:

```xml
<mi:CharacterImage id="hero" prompt={hero-prompt}
  aspect-ratio="16:9" n="1" response-format="url" prompt-optimizer="false">
  <mi:Character image={reference.image}/>
</mi:CharacterImage>
```

Neither Surface copies runtime media bytes into request metadata: every prompt
and every reference stays an explicit graph edge, so the Provider fetches the
Artifact at execution time and the Build records where it came from.

## Wiring

Selecting this package in a source is not enough; a Profile must also name the
Endpoint that serves `@hypit/minimax-image@1#image-01`. A single compatible
Endpoint resolves without a binding; several require one.