import type { AsyncEndpoint, EndpointCredential, EndpointInvocationContext, ImmediateEndpointHandler } from "@hypit/hypit/endpoint";
import { EndpointServiceError, defineEndpoint, wakeAfter } from "@hypit/hypit/endpoint";
import { EndpointHttpError, EndpointResponseError, EndpointTransportError, withRequestDeadline } from "@hypit/hypit/endpoint/http";
import { credentialRef } from "@hypit/hypit/endpoint";
import type { CredentialRef, ResourceStore } from "@hypit/hypit/endpoint";
import type { GenerationArtifactUrlResolver } from "@hypit/generation";
import { canonicalize } from "@hypit/hypit/protocol";
import type { BlobRef, CanonicalValue } from "@hypit/hypit/protocol";
import { createMinimaxRoutes, minimaxRouteForCapability, minimaxMediaLimits } from "./routes.js";
import type { MinimaxModelNames, MinimaxRoute } from "./routes.js";
import { MinimaxHttpError, MinimaxServiceError, minimaxServiceFailure } from "./errors.js";

export const minimaxProviderModuleRef = { name: "@hypit/provider-minimax", version: "1" } as const;

export type CreateMinimaxProviderOptions = {
  readonly instance?: string;
  readonly pool?: string;
  /**
   * Where the MiniMax-compatible API lives. The native service and any gateway
   * that relays the same paths differ only here, so switching between them is a
   * Profile edit rather than a code change.
   */
  readonly baseUrl?: string;
  readonly apiKey?: CredentialRef;
  /** Wire model name per capability; override to address a gateway's own aliases. */
  readonly models?: MinimaxModelNames;
  readonly defaultConcurrency?: number;
  readonly actionLimits?: import("@hypit/hypit/endpoint").EndpointActionLimits;
  readonly requestTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly operationTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Publish a referenced Resource at a URL the service can fetch, instead of inlining it. */
  readonly publicAssetUrl?: (artifact: BlobRef, artifacts: ResourceStore, fields?: Readonly<Record<string, string | number | boolean>>) => Promise<string>;
};

type Handle = {
  readonly contract: "hypit.minimax-operation@1";
  readonly taskId: string;
  readonly route: string;
  readonly startedAt: number;
  readonly fileId?: string;
};

const PATHS = {
  image: "/v1/image_generation",
  videoSubmit: "/v1/video_generation",
  videoTask: (taskId: string) => `/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
  file: (fileId: string) => `/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
} as const;

/** The service reports these as terminal; `Success` is the only good one. */
const TERMINAL = new Set(["Success", "success", "Fail", "Failed", "failed"]);

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown, subject: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${subject} must be an object`);
  return value as Record<string, unknown>;
}
function apiBaseUrl(value: string): string {
  let trimmed = value.trim();
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  assert(trimmed.length > 0, "MiniMax base URL is empty");
  return trimmed;
}
function apiKey(credentials: Readonly<Record<string, EndpointCredential>>): string {
  const value = credentials.apiKey?.secret;
  if (typeof value !== "string" || value.length === 0) {
    throw new EndpointServiceError("MINIMAX_CREDENTIAL_UNAVAILABLE",
      "MiniMax apiKey credential is unavailable; store a MiniMax API key for this Endpoint");
  }
  return value;
}
function mediaKind(mediaType: string): "image" | "video" | "audio" | undefined {
  const kind = mediaType.split("/", 1)[0];
  return kind === "image" || kind === "video" || kind === "audio" ? kind : undefined;
}
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function failure(error: unknown): { status: "failed"; failure: { code: string; message: string } } {
  if (!(error instanceof EndpointServiceError || error instanceof EndpointHttpError
    || error instanceof EndpointTransportError || error instanceof EndpointResponseError)) throw error;
  const code = error instanceof EndpointServiceError || error instanceof EndpointHttpError ? error.code : "MINIMAX_ERROR";
  return { status: "failed", failure: { code, message: failureMessage(error) } };
}
function retrying(error: unknown, handle: CanonicalValue, pollIntervalMs: number, deadlineAt?: number) {
  const delay = error instanceof EndpointTransportError ? pollIntervalMs
    : error instanceof EndpointHttpError && (error.status === 429 || error.status >= 500)
      ? error.retryAfterMs ?? pollIntervalMs : undefined;
  if (delay === undefined) return undefined;
  const now = Date.now();
  return { status: "pending" as const, handle, wakeAt: Math.min(now + delay, deadlineAt ?? Number.MAX_SAFE_INTEGER), progress: { phase: "retrying" } };
}

/**
 * A frame travels inline as a data URL unless a deployment publishes it. Bytes
 * are read from the Resource Store at execution time; the Author surface copies
 * none of them into request metadata.
 */
function resolverFor(route: MinimaxRoute, context: EndpointInvocationContext,
  publicAssetUrl: CreateMinimaxProviderOptions["publicAssetUrl"]): GenerationArtifactUrlResolver {
  const resolved = new Map<string, Promise<string>>();
  return (artifact, fields) => {
    const existing = resolved.get(artifact.resource);
    if (existing !== undefined) return existing;
    const promise = (async () => {
      if (publicAssetUrl !== undefined) return await publicAssetUrl(artifact, context.resources, fields);
      const kind = mediaKind(artifact.mediaType);
      assert(kind === "image",
        `MiniMax accepts image references only; ${artifact.resource} is ${artifact.mediaType}`);
      assert(artifact.size <= route.mediaLimits.image,
        `MiniMax accepts image references up to ${route.mediaLimits.image / 1_000_000} MB; ${artifact.resource} is ${artifact.size} bytes`);
      const bytes = await context.resources.get(artifact.resource);
      assert(bytes !== undefined && bytes.byteLength === artifact.size,
        `Reference Resource ${artifact.resource} is unavailable or has changed`);
      return `data:${artifact.mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
    })();
    resolved.set(artifact.resource, promise);
    return promise;
  };
}

class MinimaxClient {
  constructor(readonly baseUrl: string, readonly timeout: number, readonly fetcher: typeof globalThis.fetch) {}
  async json(path: string, key: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    return await withRequestDeadline(this.timeout, async ({ signal, wait }) => {
      const response = await wait(this.fetcher(`${this.baseUrl}${path}`, {
        ...init, signal, headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
      }));
      const text = await wait(response.text());
      if (!response.ok) {
        let model: string | undefined;
        if (typeof init.body === "string") {
          try { const input = JSON.parse(init.body) as { model?: unknown }; if (typeof input.model === "string") model = input.model; } catch { /* evidence is the HTTP status */ }
        }
        throw new MinimaxHttpError(response.status, response, text, { method: init.method ?? "GET", path, ...(model === undefined ? {} : { model }) });
      }
      let body: unknown;
      try { body = text.length === 0 ? {} : JSON.parse(text); } catch { throw new EndpointResponseError(`MiniMax returned invalid JSON (${response.status})`); }
      return object(body, "MiniMax response");
    }, () => new EndpointTransportError("MiniMax request timed out", { timeout: true }));
  }
  async download(url: string): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
    return await withRequestDeadline(this.timeout, async ({ signal, wait }) => {
      const response = await wait(this.fetcher(url, { signal }));
      if (!response.ok) throw new MinimaxHttpError(response.status, response, "", { method: "GET", path: url });
      return {
        bytes: new Uint8Array(await wait(response.arrayBuffer())),
        mediaType: response.headers.get("content-type")?.split(";", 1)[0] ?? "application/octet-stream",
      };
    });
  }
}

async function store(client: MinimaxClient, urls: readonly string[], resources: ResourceStore): Promise<BlobRef[]> {
  const blobs: BlobRef[] = [];
  for (const url of urls) {
    const downloaded = await client.download(url);
    blobs.push(await resources.put(downloaded.bytes, downloaded.mediaType));
  }
  return blobs;
}

/** MiniMax returns either signed URLs or inline Base64, chosen by the author. */
function payloads(response: Record<string, unknown>): { readonly urls: string[]; readonly inline: string[] } {
  const data = object(response.data ?? {}, "MiniMax response data");
  const urls = Array.isArray(data.image_urls) ? data.image_urls.filter((value): value is string => typeof value === "string") : [];
  const inline = Array.isArray(data.image_base64) ? data.image_base64.filter((value): value is string => typeof value === "string") : [];
  return { urls, inline };
}

function imageHandler(client: MinimaxClient, routes: readonly MinimaxRoute[], publicAssetUrl: CreateMinimaxProviderOptions["publicAssetUrl"]): ImmediateEndpointHandler {
  return async (context) => {
    const route = minimaxRouteForCapability(context.need.capability, routes);
    assert(route !== undefined, "MiniMax does not implement this exact capability");
    const request = route.prepare(context.need.constraints);
    await context.reportProgress?.({ phase: `Preparing MiniMax request: ${request.model}` });
    const body = JSON.stringify(await request.compile(resolverFor(route, context, publicAssetUrl)));
    assert(Buffer.byteLength(body) <= route.mediaLimits.body,
      `MiniMax accepts request bodies up to ${route.mediaLimits.body / 1_000_000} MB; inline references make this one ${Buffer.byteLength(body)} bytes`);
    await context.reportProgress?.({ phase: `Submitting MiniMax request: ${request.model}` });
    const response = await client.json(PATHS.image, apiKey(context.credentials), {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    // A 200 can still be a rejection: MiniMax reports that under base_resp.
    const rejected = minimaxServiceFailure(response, request.model);
    if (rejected !== undefined) throw rejected;
    const { urls, inline } = payloads(response);
    await context.reportProgress?.({ phase: "Receiving generated images" });
    const blobs = urls.length > 0 ? await store(client, urls, context.resources) : [];
    for (const encoded of inline) {
      assert(encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(encoded),
        "MiniMax returned malformed Base64 image data");
      const bytes = Buffer.from(encoded, "base64");
      assert(bytes.byteLength > 0, "MiniMax returned an empty image");
      blobs.push(await context.resources.put(new Uint8Array(bytes), "image/jpeg"));
    }
    assert(blobs.length > 0, "MiniMax returned no image for this request");
    return { value: route.packageResult(blobs) };
  };
}

function videoEndpoint(client: MinimaxClient, routes: readonly MinimaxRoute[], pollIntervalMs: number, maxOperationMs: number,
  publicAssetUrl: CreateMinimaxProviderOptions["publicAssetUrl"]): AsyncEndpoint {
  return {
    async start(context) {
      try {
        const route = minimaxRouteForCapability(context.need.capability, routes);
        assert(route !== undefined, "MiniMax does not implement this exact capability");
        const request = route.prepare(context.need.constraints);
        await context.reportProgress?.({ phase: `Preparing MiniMax request: ${request.model}` });
        const body = JSON.stringify(await request.compile(resolverFor(route, context, publicAssetUrl)));
        assert(Buffer.byteLength(body) <= route.mediaLimits.body,
          `MiniMax accepts request bodies up to ${route.mediaLimits.body / 1_000_000} MB; inline frames make this one ${Buffer.byteLength(body)} bytes`);
        await context.reportProgress?.({ phase: `Submitting MiniMax request: ${request.model}` });
        const response = await client.json(PATHS.videoSubmit, apiKey(context.credentials), {
          method: "POST", headers: { "content-type": "application/json" }, body,
        });
        const rejected = minimaxServiceFailure(response, request.model);
        if (rejected !== undefined) return failure(rejected);
        const taskId = response.task_id;
        assert(typeof taskId === "string" && taskId.length > 0, "MiniMax accepted the request but returned no task_id");
        const handle: Handle = { contract: "hypit.minimax-operation@1", taskId, route: route.key, startedAt: Date.now() };
        const receipt = { id: taskId };
        await context.checkpoint?.({ handle: canonicalize(handle), receipt });
        return { ...wakeAfter(canonicalize(handle), pollIntervalMs, Date.now(), { phase: "submitted" }), receipt };
      } catch (error) {
        return failure(error);
      }
    },
    async poll(context) {
      let deadlineAt: number | undefined;
      try {
        const handle = object(context.handle, "MiniMax handle") as unknown as Handle;
        const route = minimaxRouteForCapability(context.need.capability, routes);
        assert(route !== undefined && handle.contract === "hypit.minimax-operation@1" && handle.route === route.key,
          "MiniMax handle is invalid");
        const receipt = { id: handle.taskId };
        deadlineAt = handle.startedAt + maxOperationMs;
        if (Date.now() >= deadlineAt) {
          return { status: "failed", receipt, failure: {
            code: "MINIMAX_OPERATION_TIMEOUT",
            message: `MiniMax task ${handle.taskId} exceeded this Provider's operationTimeoutMs (${maxOperationMs}); remote outcome is unknown`,
          } };
        }
        const task = await client.json(PATHS.videoTask(handle.taskId), apiKey(context.credentials));
        const rejected = minimaxServiceFailure(task, route.capability.name);
        if (rejected !== undefined) return { ...failure(rejected), receipt };
        const status = String(task.status ?? "");
        if (!TERMINAL.has(status)) return { ...wakeAfter(canonicalize(handle), pollIntervalMs, Date.now(), { phase: status || "working" }), receipt };
        if (status !== "Success" && status !== "success") {
          return { status: "failed", receipt, failure: {
            code: "MINIMAX_TASK_FAILED",
            message: `MiniMax task ${handle.taskId} ${status}: ${String(task.message ?? task.error ?? "no reason supplied")}`,
          } };
        }
        const fileId = task.file_id;
        assert(typeof fileId === "string" && fileId.length > 0,
          `MiniMax task ${handle.taskId} succeeded but returned no file_id`);
        return { status: "ready", handle: canonicalize({ ...handle, fileId }), receipt };
      } catch (error) {
        return retrying(error, context.handle, pollIntervalMs, deadlineAt) ?? failure(error);
      }
    },
    async collect(context) {
      try {
        const handle = object(context.handle, "MiniMax handle") as unknown as Handle;
        const route = minimaxRouteForCapability(context.need.capability, routes);
        assert(route !== undefined && handle.route === route.key, "MiniMax collection route differs");
        assert(typeof handle.fileId === "string" && handle.fileId.length > 0, "MiniMax handle has no file_id to collect");
        await context.reportProgress?.({ phase: "Receiving generated video" });
        const retrieved = await client.json(PATHS.file(handle.fileId), apiKey(context.credentials));
        const url = retrieved.download_url ?? object(retrieved.file ?? {}, "MiniMax file").download_url;
        assert(typeof url === "string" && url.length > 0, "MiniMax retrieve response has no download_url");
        const downloaded = await client.download(url);
        const blob = await context.resources.put(downloaded.bytes, downloaded.mediaType);
        return { status: "completed", result: { value: route.packageResult([blob]) }, receipt: { id: handle.taskId } };
      } catch (error) {
        return retrying(error, context.handle, pollIntervalMs) ?? failure(error);
      }
    },
  };
}

export function createMinimaxProvider(options: CreateMinimaxProviderOptions = {}) {
  const requestTimeoutMs = options.requestTimeoutMs ?? 300_000;
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  const operationTimeoutMs = options.operationTimeoutMs ?? 30 * 60_000;
  for (const [name, value] of Object.entries({ requestTimeoutMs, pollIntervalMs, operationTimeoutMs })) {
    assert(Number.isSafeInteger(value) && value > 0, `MiniMax ${name} must be a positive integer`);
  }
  const client = new MinimaxClient(
    apiBaseUrl(options.baseUrl ?? "https://api.minimaxi.com"), requestTimeoutMs, options.fetch ?? globalThis.fetch);
  const routes = createMinimaxRoutes(options.models);
  const video = videoEndpoint(client, routes, pollIntervalMs, operationTimeoutMs, options.publicAssetUrl);
  return defineEndpoint({
    instance: options.instance ?? "minimax.default", pool: options.pool ?? options.instance ?? "minimax.default",
    pricing: { kind: "page", url: "https://platform.minimaxi.com/docs/price" },
    credentials: { apiKey: options.apiKey ?? credentialRef("local", "minimax.api-key") },
    credentialInputs: { apiKey: { label: "MiniMax API key" } },
    defaultConcurrency: options.defaultConcurrency ?? 4,
    ...(options.actionLimits === undefined ? {} : { actionLimits: options.actionLimits }),
    capabilities: routes.map((route) => route.result === "image"
      ? {
        capability: route.capability, returns: route.returns, lifecycle: "immediate" as const,
        handler: imageHandler(client, routes, options.publicAssetUrl), capacity: route.capability.name, supports: route.supports,
      }
      : {
        capability: route.capability, returns: route.returns, lifecycle: "asynchronous" as const,
        endpoint: video, capacity: route.capability.name, supports: route.supports,
      }),
  });
}