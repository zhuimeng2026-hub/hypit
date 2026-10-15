import {
  compileWireRequest,
  selectWireModelForRequest,
  generationTypes,
  sealGeneratedImageSet,
  sealGeneratedVideoSet,
} from "@hypit/generation";
import type { GenerationArtifactUrlResolver, GenerationRequest, GenerationWireMapping } from "@hypit/generation";
import { canonicalize } from "@hypit/hypit/protocol";
import type { BlobRef, CapabilityRef, CanonicalValue, StoredValue, TypeRef } from "@hypit/hypit/protocol";
import type { EndpointRequest, EndpointSupport } from "@hypit/hypit/endpoint";
import { minimaxMappings } from "./mapping.js";

/**
 * Documented limits for one request. The service accepts a media reference as a
 * data URL or a fetchable URL; this Provider inlines it, so the body cap is what
 * bounds a reference picture.
 */
export type MinimaxMediaLimits = {
  readonly image: number;
  readonly body: number;
};

const MB = 1_000_000;

export const minimaxMediaLimits: MinimaxMediaLimits = { image: 10 * MB, body: 20 * MB };

/**
 * Wire model name per capability, defaulting to the native MiniMax identifiers.
 * A deployment that fronts the service with a unified gateway overrides only
 * these names, because such a gateway exposes its own aliases on the same paths.
 */
export type MinimaxModelNames = Readonly<Record<string, string>>;

export const minimaxDefaultModels: MinimaxModelNames = Object.freeze(Object.fromEntries(
  minimaxMappings.map((mapping) => [mapping.capability.name, mapping.routes[0]!.model]),
));

export type MinimaxPreparedRequest = {
  readonly model: string;
  readonly compile: (resolve: GenerationArtifactUrlResolver) => Promise<Record<string, unknown>>;
};

export type MinimaxRoute = GenerationWireMapping & {
  readonly key: string;
  readonly returns: TypeRef;
  readonly mediaLimits: MinimaxMediaLimits;
  readonly supports: (request: EndpointRequest) => EndpointSupport;
  readonly prepare: (constraints: CanonicalValue) => MinimaxPreparedRequest;
  readonly packageResult: (artifacts: readonly BlobRef[]) => StoredValue;
};

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function capabilityKey(capability: CapabilityRef): string {
  return `${capability.module.name}@${capability.module.version}#${capability.name}`;
}
function scalar(request: GenerationRequest, port: string): string | number | boolean | undefined {
  const value = request.ports[port]?.[0];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}
function scalarText(request: GenerationRequest, port: string): string | undefined {
  const value = scalar(request, port);
  return value === undefined ? undefined : String(value);
}

/** Limits the service states for itself: "n must be between 1 and 9". */
const MAX_SUBJECT_REFERENCES = 10;

/**
 * A reason this service cannot serve the request, or `undefined` when it can.
 * Reported from `supports` so `plan` refuses before a Build spends anything.
 */
function rejection(request: GenerationRequest): string | undefined {
  const n = scalar(request, "n");
  if (typeof n === "number" && (!Number.isInteger(n) || n < 1 || n > 9)) {
    return `MiniMax image-01 renders between 1 and 9 pictures per request; this one asks for ${String(n)}`;
  }
  const format = scalarText(request, "responseFormat");
  if (format !== undefined && format !== "url" && format !== "base64") {
    return `MiniMax image-01 returns either url or base64; this one asks for ${format}`;
  }
  const references = request.ports.subjectReference ?? [];
  if (references.length > MAX_SUBJECT_REFERENCES) {
    return `MiniMax image-01 accepts up to ${MAX_SUBJECT_REFERENCES} character references; this one supplies ${references.length}`;
  }
  return undefined;
}

/**
 * Build the routes for one deployment's model names. Passing `models` is how a
 * gateway front-end substitutes its aliases without touching any mapping.
 */
export function createMinimaxRoutes(models: MinimaxModelNames = minimaxDefaultModels): readonly MinimaxRoute[] {
  return minimaxMappings.map((mapping) => {
    const name = mapping.capability.name;
    const configured = models[name];
    assert(configured === undefined || (typeof configured === "string" && configured.trim().length > 0),
      `MiniMax wire model name for ${name} must be a non-empty string`);
    const routed: GenerationWireMapping = configured === undefined
      ? mapping
      : { ...mapping, routes: [{ model: configured }] };
    return {
      ...routed,
      key: capabilityKey(routed.capability),
      returns: routed.result === "image" ? generationTypes.imageSet : generationTypes.videoSet,
      mediaLimits: minimaxMediaLimits,
      supports: (request) => {
        const reason = rejection(request.constraints as unknown as GenerationRequest);
        return reason === undefined ? { status: "supported" } : { status: "unsupported", reason };
      },
      prepare: (constraints) => {
        const request = constraints as unknown as GenerationRequest;
        const reason = rejection(request);
        if (reason !== undefined) throw new Error(reason);
        return {
          model: selectWireModelForRequest(routed, request),
          // The service selects its model from the body's own `model` field, so the
          // selected route travels with the fields rather than beside them.
          compile: async (resolve) => {
            const compiled = await compileWireRequest(routed, request, resolve);
            const input = compiled.input;
            assert(typeof input === "object" && input !== null && !Array.isArray(input),
              "compiled MiniMax request fields must be an object");
            return { model: compiled.model, ...input };
          },
        };
      },
      packageResult: (artifacts) => ({
        kind: "inline",
        value: canonicalize(routed.result === "image"
          ? sealGeneratedImageSet({ images: artifacts })
          : sealGeneratedVideoSet({ videos: artifacts })),
      }),
    };
  });
}

export function minimaxRouteForCapability(capability: CapabilityRef, routes: readonly MinimaxRoute[]): MinimaxRoute | undefined {
  return routes.find((route) => route.key === capabilityKey(capability));
}