import assert from "node:assert/strict";
import test from "node:test";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/executor";
import { credentialRef } from "@hypit/endpoint";
import type { EndpointInvocationContext } from "@hypit/endpoint";
import type { BlobRef, CapabilityRef, TypeRef } from "@hypit/protocol";
import { canonicalize } from "@hypit/protocol";
import { generationTypes, sealGeneratedImageSet } from "@hypit/generation";
import { minimaxImage01Ports, sealMinimaxImage01Request } from "@hypit/minimax-image";

import { createMinimaxProvider } from "../src/provider.js";

const capability: CapabilityRef = { module: { name: "@hypit/minimax-image", version: "1" }, name: "image-01" };

/** One PNG pixel, so a downloaded image is a real Artifact rather than an empty Blob. */
const png = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
), (character) => character.charCodeAt(0));

function needFor(ports: Record<string, unknown>) {
  return {
    capability,
    returns: generationTypes.imageSet as TypeRef,
    constraints: canonicalize(sealMinimaxImage01Request({
      prompt: ["a red cube"], aspectRatio: ["16:9"], n: [1],
      responseFormat: ["url"], promptOptimizer: [false], ...ports,
    } as never)),
  };
}

type Need = ReturnType<typeof needFor>;

/** `resolve` returns a discriminated union; these tests only ever reach a resolved Endpoint. */
function resolvedRegistration(registry: EndpointRegistry, need: Need) {
  const resolution = registry.resolve(need);
  assert.equal(resolution.status, "resolved");
  if (resolution.status !== "resolved" || resolution.registration.kind !== "immediate") {
    throw new Error(`expected a resolved immediate Endpoint, got ${resolution.status}`);
  }
  return resolution.registration;
}

function harness(responses: (() => Response)[]) {
  const calls: { url: string; body: unknown }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ url, body });
    return responses.shift()!();
  }) as typeof globalThis.fetch;
  const provider = createMinimaxProvider({
    instance: "minimax.test", pool: "minimax.test", apiKey: credentialRef("env", "MINIMAX_API_KEY"), fetch: fetcher,
  });
  const registry = new EndpointRegistry();
  provider.install(registry);
  const resolution = registry.resolve(needFor({}));
  return { calls, registry, resolution, provider };
}

function contextFor(need: ReturnType<typeof needFor>, resources: MemoryResourceStore, progress: string[]) {
  return {
    need, command: { kind: "fulfill-need", id: "command:test", need },
    resources, credentials: { apiKey: { secret: "test-key" } },
    reportProgress: async (value: { phase: string }) => { progress.push(value.phase); },
  } as unknown as EndpointInvocationContext;
}

test("the Endpoint serves image-01 as an immediate capability", () => {
  const { resolution } = harness([]);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.registration.kind, "immediate");
});

test("a successful request posts the wire body and stores the returned image", async () => {
  const progress: string[] = [];
  const responses = [
    () => new Response(JSON.stringify({
      id: "r1", data: { image_urls: ["https://cdn.test/a.png"] }, base_resp: { status_code: 0, status_msg: "success" },
    }), { status: 200, headers: { "content-type": "application/json" } }),
    () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
  ];
  const { calls, registry } = harness(responses);
  const resources = new MemoryResourceStore();
  const registration = resolvedRegistration(registry, needFor({}));
  const outcome = await (registration.handler as (context: EndpointInvocationContext) => Promise<unknown>)(contextFor(needFor({}), resources, progress));

  assert.equal(calls[0]?.url, "https://api.minimaxi.com/v1/image_generation");
  assert.deepEqual(calls[0]?.body, {
    model: "image-01", prompt: "a red cube", aspect_ratio: "16:9",
    n: 1, response_format: "url", prompt_optimizer: false,
  });
  assert.deepEqual(progress, [
    "Preparing MiniMax request: image-01",
    "Submitting MiniMax request: image-01",
    "Receiving generated images",
  ]);
  const value = (outcome as { value: { value: unknown } }).value.value as { images?: BlobRef[] };
  assert.equal(value.images?.length, 1);
});

test("a 200 carrying a base_resp rejection fails instead of silently returning nothing", async () => {
  const responses = [() => new Response(JSON.stringify({
    id: "r2", data: null,
    base_resp: { status_code: 1027, status_msg: "output new_sensitive" },
  }), { status: 200, headers: { "content-type": "application/json" } })];
  const { registry } = harness(responses);
  const registration = resolvedRegistration(registry, needFor({}));
  await assert.rejects(
    async () => await (registration.handler as (context: EndpointInvocationContext) => Promise<unknown>)
      (contextFor(needFor({}), new MemoryResourceStore(), [])),
    /status_code 1027: output new_sensitive/,
  );
});

test("a failure never leaks the credential or a signed URL into the message", async () => {
  const responses = [() => new Response(JSON.stringify({
    base_resp: { status_code: 2013, status_msg: "rejected https://hailuo-image.oss.example.com/x.jpeg?Signature=secret" },
  }), { status: 200, headers: { "content-type": "application/json" } })];
  const { registry } = harness(responses);
  const registration = resolvedRegistration(registry, needFor({}));
  await assert.rejects(
    async () => await (registration.handler as (context: EndpointInvocationContext) => Promise<unknown>)
      (contextFor(needFor({}), new MemoryResourceStore(), [])),
    (error: Error) => {
      assert.doesNotMatch(error.message, /test-key/u);
      assert.doesNotMatch(error.message, /Signature=secret/u);
      assert.match(error.message, /\[redacted-url\]/u);
      return true;
    },
  );
});

test("a response with no image is a failure, not an empty success", async () => {
  const responses = [() => new Response(JSON.stringify({
    data: {}, base_resp: { status_code: 0, status_msg: "success" },
  }), { status: 200, headers: { "content-type": "application/json" } })];
  const { registry } = harness(responses);
  const registration = resolvedRegistration(registry, needFor({}));
  await assert.rejects(
    async () => await (registration.handler as (context: EndpointInvocationContext) => Promise<unknown>)
      (contextFor(needFor({}), new MemoryResourceStore(), [])),
    /returned no image/,
  );
});

test("an inline base64 response becomes a stored image without a second request", async () => {
  const responses = [() => new Response(JSON.stringify({
    data: { image_base64: [Buffer.from(png).toString("base64")] }, base_resp: { status_code: 0 },
  }), { status: 200, headers: { "content-type": "application/json" } })];
  const { calls, registry } = harness(responses);
  const registration = resolvedRegistration(registry, needFor({ responseFormat: ["base64"] }));
  const resources = new MemoryResourceStore();
  const outcome = await (registration.handler as (context: EndpointInvocationContext) => Promise<unknown>)(contextFor(needFor({ responseFormat: ["base64"] }), resources, []));
  assert.equal(calls.length, 1, "inline Base64 must not trigger a download");
  const value = (outcome as { value: { value: unknown } }).value.value as { images?: BlobRef[] };
  assert.equal(value.images?.[0]?.size, png.byteLength);
});

test("the packaged result is an ordinary GeneratedImageSet", () => {
  const blob: BlobRef = { kind: "blob", resource: "res_1", size: 3, mediaType: "image/png" };
  const sealed = sealGeneratedImageSet({ images: [blob] });
  assert.equal(sealed.images.length, 1);
  assert.equal(minimaxImage01Ports.model, "image-01");
});