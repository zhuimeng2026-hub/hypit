import { blobTypes } from "@hypit/hypit/blob";
import { sealGenerationPortRequest, sealGenerationPortTable } from "@hypit/generation";
import type { GenerationPortTable, GenerationPortValue, GenerationRequest } from "@hypit/generation";
import type { SurfaceAttributeVocabulary } from "@hypit/hypit/markup";
import { defineExactModelModule } from "@hypit/generation/model";
import { textTypes } from "@hypit/hypit/text";

export const minimaxHailuoModuleRef = { name: "@hypit/minimax-hailuo", version: "1" } as const;

/**
 * What MiniMax `MiniMax-Hailuo-2.3` accepts is a property of that trained model,
 * not of whichever service resells it. The Service owns the wire names; this
 * table owns the vocabulary.
 *
 * Every value below was read back from the live endpoint's own validation
 * messages. The endpoint validates a request before it checks quota, so a field
 * it recognises rejects a wrongly-typed value with 2013 while a field it does not
 * know passes through to the quota check — that difference is what identifies it.
 *
 *   duration        → "supported durations: 6s, 10s"
 *   resolution      → "supported resolutions: 768P, 1080P"
 *   duration+res    → "does not support the combination of duration 10s and resolution 1080P"
 *   first_frame_image / last_frame_image / prompt_optimizer → recognised
 *   aspect_ratio, reference_image, reference_video, reference_audio → NOT accepted;
 *     each behaved exactly like a field invented on the spot
 *   subject_reference → the field exists, but this model answers
 *     "does not support Subject-Reference-Video mode", so it is not offered here
 *
 * This is deliberately NOT the same vocabulary as `@hypit/minimax-h3`: that model
 * accepts `2K`, `aspectRatio` and the three `reference*` media ports, none of
 * which Hailuo-2.3 honours. Merging them would force one of the two to send
 * fields the service ignores or rejects.
 */
export const hailuoI2vPorts: GenerationPortTable = sealGenerationPortTable({
  model: "hailuo-i2v",
  result: "video",
  ports: [
    { name: "prompt", value: { kind: "text", maxChars: 7_000 }, minItems: 1, maxItems: 1 },
    { name: "duration", value: { kind: "number", integer: true, minimum: 6, maximum: 10 }, minItems: 1, maxItems: 1 },
    { name: "resolution", value: { kind: "enum", values: ["768P", "1080P"] }, minItems: 1, maxItems: 1 },
    /** The picture the motion starts from; this is what makes the model frame-guided. */
    { name: "firstFrame", value: { kind: "media", accepts: ["image"] }, minItems: 0, maxItems: 1 },
    { name: "lastFrame", value: { kind: "media", accepts: ["image"] }, minItems: 0, maxItems: 1 },
    { name: "promptOptimizer", value: { kind: "boolean" }, minItems: 1, maxItems: 1 },
  ],
  requires: [],
});

/**
 * The service rejects one duration/resolution pair outright. A port table cannot
 * express a rule across two independent scalars, so the complete-request check
 * owns it and refuses before any Endpoint is selected.
 */
export function verifyHailuoI2vRequest(request: GenerationRequest): void {
  const duration = request.ports.duration?.[0];
  const resolution = request.ports.resolution?.[0];
  if (duration === 10 && resolution === "1080P") {
    throw new Error(
      "MiniMax-Hailuo-2.3 does not support the combination of duration 10s and resolution 1080P; use 10s at 768P or 6s at 1080P",
    );
  }
}

export function sealHailuoI2vRequest(
  ports: Readonly<Record<string, readonly GenerationPortValue[]>>,
): GenerationRequest {
  return sealGenerationPortRequest(hailuoI2vPorts, ports);
}

const hailuoBaseDefinition = defineExactModelModule({
  module: minimaxHailuoModuleRef,
  endpoints: [{
    key: "i2v",
    requestTypeName: "HailuoI2VRequest",
    producerName: "request-hailuo-i2v",
    ports: hailuoI2vPorts,
    validateRequest: verifyHailuoI2vRequest,
  }],
});

export const hailuoEndpoints = hailuoBaseDefinition.endpoints;
export const hailuoComponent = hailuoBaseDefinition.component;
const endpoint = hailuoEndpoints.i2v!;

const hailuoAttributes: readonly SurfaceAttributeVocabulary[] = [
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
    summary: "The Text edge describing the motion the model renders.",
    accepts: [textTypes.text],
  },
  {
    name: "duration",
    kind: "literal",
    required: true,
    summary: "How many seconds the clip runs. The model accepts 6 or 10.",
  },
  {
    name: "resolution",
    kind: "literal",
    required: true,
    summary: "The render band. 10s is available at 768P only.",
    values: ["768P", "1080P"],
  },
  {
    name: "prompt-optimizer",
    kind: "literal",
    required: true,
    summary: "Whether the service may rewrite the prompt before rendering. The author chooses.",
    values: ["true", "false"],
  },
];

const frameAttributes: readonly SurfaceAttributeVocabulary[] = [
  {
    name: "first-frame",
    kind: "reference",
    required: false,
    summary: "The picture the motion starts from. At least one frame is required by FrameVideo.",
    accepts: [blobTypes.blob],
  },
  {
    name: "last-frame",
    kind: "reference",
    required: false,
    summary: "The picture the motion arrives at.",
    accepts: [blobTypes.blob],
  },
];

const hailuoVideoPort = {
  name: "video",
  type: blobTypes.blob,
  summary: "The generated video Artifact, addressed as `<id>.video`.",
} as const;

export const hailuoMarkupSurfaces = [{
    name: "text-video", tag: "TextVideo", mode: "structured" as const,
    outputs: [endpoint.draftType],
    vocabulary: {
      summary: "Generates one clip with the exact MiniMax-Hailuo-2.3 model from a motion prompt alone.",
      attributes: hailuoAttributes,
      ports: [hailuoVideoPort],
      example: `<hailuo:TextVideo id="drift" prompt={motionPrompt}
  duration="6" resolution="1080P" prompt-optimizer="true"/>`,
      notes: [
        "This model accepts no aspect ratio; duration and resolution alone determine the shape.",
        "Every request field is written by the author; the Runtime chooses no model on the author's behalf.",
      ],
    },
  }, {
    name: "frame-video", tag: "FrameVideo", mode: "structured" as const,
    outputs: [endpoint.draftType, endpoint.mediaBindings.firstFrame!.type, endpoint.mediaBindings.lastFrame!.type],
    vocabulary: {
      summary: "Generates one clip that starts from, or arrives at, an authored picture.",
      attributes: [...hailuoAttributes, ...frameAttributes],
      ports: [hailuoVideoPort],
      example: `<hailuo:FrameVideo id="glide" prompt={motionPrompt}
  duration="6" resolution="1080P" prompt-optimizer="true"
  first-frame={still.image}/>`,
      notes: [
        "At least one of `first-frame` and `last-frame` is required; the element rejects neither.",
        "The Surface copies no runtime media into request metadata; every frame stays a graph edge.",
      ],
    },
  }] as const;

export const hailuoManifest = {
  ...hailuoBaseDefinition.manifest,
};
export const hailuoDefinition = {
  ...hailuoBaseDefinition, manifest: hailuoManifest,
};