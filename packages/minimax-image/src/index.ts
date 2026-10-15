import { blobTypes } from "@hypit/hypit/blob";
import { sealGenerationPortRequest, sealGenerationPortTable } from "@hypit/generation";
import type { GenerationPortTable, GenerationPortValue, GenerationRequest } from "@hypit/generation";
import type { SurfaceAttributeVocabulary } from "@hypit/hypit/markup";
import { defineExactModelModule } from "@hypit/generation/model";
import { textTypes } from "@hypit/hypit/text";

export const minimaxImageModuleRef = { name: "@hypit/minimax-image", version: "1" } as const;

/**
 * What MiniMax `image-01` accepts is a property of that trained model, not of
 * whichever service resells it. The Service owns the wire names; this table owns
 * the vocabulary.
 *
 * Every value below was read back from the live endpoint's own validation
 * messages rather than assumed:
 *   aspect_ratio      → "must be one of [1:1 16:9 4:3 3:2 2:3 3:4 9:16 21:9]"
 *   n                 → "must be between 1 and 9"
 *   response_format   → "not 'url' or 'base64'"
 *   subject_reference → "must be character"
 *
 * Note `response_format` values are `url` and `base64` — NOT `b64_json`, which
 * is the name OpenAI-style services use for the same idea.
 */
export const minimaxImage01Ports: GenerationPortTable = sealGenerationPortTable({
  model: "image-01",
  result: "image",
  ports: [
    { name: "prompt", value: { kind: "text", maxChars: 3_000 }, minItems: 1, maxItems: 1 },
    {
      name: "aspectRatio",
      value: { kind: "enum", values: ["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"] },
      minItems: 1,
      maxItems: 1,
    },
    { name: "n", value: { kind: "number", integer: true, minimum: 1, maximum: 9 }, minItems: 1, maxItems: 1 },
    { name: "responseFormat", value: { kind: "enum", values: ["url", "base64"] }, minItems: 1, maxItems: 1 },
    { name: "promptOptimizer", value: { kind: "boolean" }, minItems: 1, maxItems: 1 },
    /**
     * Character references. The service accepts only `character` today; it
     * rejects anything else with "subject_reference must be character", so this
     * port states that single role rather than a wider vocabulary the model
     * cannot honour.
     */
    { name: "subjectReference", value: { kind: "media", accepts: ["image"], itemFields: [{ name: "type", value: { kind: "enum", values: ["character"] } }] }, minItems: 0, maxItems: 10 },
  ],
  requires: [],
});

export function sealMinimaxImage01Request(
  ports: Readonly<Record<string, readonly GenerationPortValue[]>>,
): GenerationRequest {
  return sealGenerationPortRequest(minimaxImage01Ports, ports);
}

const minimaxImageBaseDefinition = defineExactModelModule({
  module: minimaxImageModuleRef,
  endpoints: [{
    key: "image",
    requestTypeName: "MinimaxImage01Request",
    producerName: "request-image-01",
    ports: minimaxImage01Ports,
  }],
});

export const minimaxImageEndpoints = minimaxImageBaseDefinition.endpoints;
export const minimaxImageComponent = minimaxImageBaseDefinition.component;
const endpoint = minimaxImageEndpoints.image!;

const minimaxImageAttributes: readonly SurfaceAttributeVocabulary[] = [
  {
    name: "id",
    kind: "identifier",
    required: true,
    summary: "Names this generation and prefixes the bindings it publishes.",
  },
  {
    name: "prompt",
    kind: "reference",
    required: true,
    summary: "The Text edge describing the picture the model renders.",
    accepts: [textTypes.text],
  },
  {
    name: "aspect-ratio",
    kind: "literal",
    required: true,
    summary: "The shape of the generated picture.",
    values: ["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"],
  },
  {
    name: "n",
    kind: "literal",
    required: true,
    summary: "How many pictures one request renders, 1 to 9.",
  },
  {
    name: "response-format",
    kind: "literal",
    required: true,
    summary: "How the service returns each picture, as a short-lived URL or inline Base64.",
    values: ["url", "base64"],
  },
  {
    name: "prompt-optimizer",
    kind: "literal",
    required: true,
    summary: "Whether the service may rewrite the prompt before rendering. The author chooses; the Provider never turns it on silently.",
    values: ["true", "false"],
  },
];

const minimaxImagePort = {
  name: "image",
  type: blobTypes.blob,
  summary: "The primary generated image, addressed as `<id>.image`.",
} as const;

export const minimaxImageMarkupSurfaces = [{
    name: "text-image", tag: "TextImage", mode: "structured" as const,
    outputs: [endpoint.draftType],
    vocabulary: {
      summary: "Generates pictures with the exact MiniMax image-01 model from a Text prompt alone.",
      attributes: minimaxImageAttributes,
      ports: [minimaxImagePort],
      example: `<minimax-image:TextImage
  id="scene"
  prompt={prompt}
  aspect-ratio="16:9"
  n="1"
  response-format="url"
  prompt-optimizer="false"
/>`,
      notes: [
        "The element accepts no children; character references belong to `CharacterImage`.",
        "Every request field is written by the author; the Runtime chooses no model on the author's behalf.",
      ],
    },
  }, {
    name: "character-image", tag: "CharacterImage", mode: "structured" as const,
    outputs: [endpoint.draftType, endpoint.mediaBindings.subjectReference!.type],
    vocabulary: {
      summary: "Generates pictures with the exact MiniMax image-01 model from a Text prompt and one or more character reference images.",
      attributes: minimaxImageAttributes,
      children: [{
        tag: "Character",
        cardinality: "many",
        summary: "Attaches one image Artifact to the request as a character reference.",
        attributes: [{
          name: "image",
          kind: "reference",
          required: true,
          summary: "The Artifact supplied as a character reference, which must carry image media.",
          accepts: [blobTypes.blob],
        }],
      }],
      ports: [minimaxImagePort],
      example: `<minimax-image:CharacterImage
  id="hero"
  prompt={heroPrompt}
  aspect-ratio="16:9"
  n="1"
  response-format="url"
  prompt-optimizer="false"
>
  <minimax-image:Character image={reference.image}/>
</minimax-image:CharacterImage>`,
      notes: [
        "The element requires at least one `Character` child and accepts at most 10.",
        "The Surface copies no runtime media into request metadata; every reference stays a graph edge.",
      ],
    },
  }] as const;

export const minimaxImageManifest = {
  ...minimaxImageBaseDefinition.manifest,
};
export const minimaxImageDefinition = {
  ...minimaxImageBaseDefinition, manifest: minimaxImageManifest,
};