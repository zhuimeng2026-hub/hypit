import type { ModuleRef } from "@hypit/hypit/protocol";
import type { GenerationWireMapping } from "@hypit/generation";

const MINIMAX_IMAGE: ModuleRef = { name: "@hypit/minimax-image", version: "1" };
const MINIMAX_HAILUO: ModuleRef = { name: "@hypit/minimax-hailuo", version: "1" };

/**
 * MiniMax wire fields, addressed by each Model's port names.
 *
 * The port vocabulary belongs to `@hypit/minimax-image` and `@hypit/minimax-hailuo`;
 * this table only says which JSON key each port travels under, and which wire model
 * name the service is asked for by default.
 *
 * Every path here is one MiniMax serves verbatim, so a gateway that relays
 * `/v1/image_generation` and `/v1/video_generation` unchanged needs no mapping
 * change at all — only a different `baseUrl`, model name and key. That is what
 * lets a deployment switch between the native service and a unified gateway by
 * editing `hypit.runtime.json`.
 */
export const minimaxMappings: readonly GenerationWireMapping[] = [{
  capability: { module: MINIMAX_IMAGE, name: "image-01" },
  result: "image",
  routes: [{ model: "image-01" }],
  fields: {
    prompt: { as: "value", field: "prompt" },
    aspectRatio: { as: "value", field: "aspect_ratio" },
    n: { as: "value", field: "n" },
    responseFormat: { as: "value", field: "response_format" },
    promptOptimizer: { as: "value", field: "prompt_optimizer" },
    subjectReference: {
      as: "itemObject",
      field: "subject_reference",
      urlKey: "image_file",
      fieldKeys: { type: "type" },
    },
  },
}, {
  capability: { module: MINIMAX_HAILUO, name: "hailuo-i2v" },
  result: "video",
  routes: [{ model: "MiniMax-Hailuo-2.3" }],
  fields: {
    prompt: { as: "value", field: "prompt" },
    duration: { as: "value", field: "duration" },
    resolution: { as: "value", field: "resolution" },
    promptOptimizer: { as: "value", field: "prompt_optimizer" },
    // The service takes a frame as a data URL or a fetchable URL. It validates a
    // first and a last frame independently, so each keeps its own port.
    firstFrame: { as: "url", field: "first_frame_image" },
    lastFrame: { as: "url", field: "last_frame_image" },
  },
}];