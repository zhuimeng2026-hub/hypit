import assert from "node:assert/strict";
import test from "node:test";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/executor";
import { credentialRef } from "@hypit/endpoint";
import type { AsyncEndpoint, EndpointInvocationContext } from "@hypit/endpoint";
import { canonicalize } from "@hypit/protocol";
import type { BlobRef, CanonicalValue, CapabilityRef } from "@hypit/protocol";
import { generationTypes } from "@hypit/generation";
import { sealHailuoI2vRequest, verifyHailuoI2vRequest } from "@hypit/minimax-hailuo";

import { createMinimaxProvider } from "../src/provider.js";

const capability: CapabilityRef = { module: { name: "@hypit/minimax-hailuo", version: "1" }, name: "hailuo-i2v" };

const mp4 = Uint8Array.from(atob(
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAAhtZGF0",
), (character) => character.charCodeAt(0));

type Need = {
  readonly capability: CapabilityRef;
  readonly returns: typeof generationTypes.videoSet;
  readonly constraints: CanonicalValue;
};

function need(ports: Record<string, unknown>): Need {
  return {
    capability,
    returns: generationTypes.videoSet,
    constraints: canonicalize(sealHailuoI2vRequest({
      prompt: ["a boy glides forward"], duration: [6], resolution: ["768P"], promptOptimizer: [false], ...ports,
    } as never)),
  };
}

/** Queue one canned response per expected call, and record every request. */
function harness(responses: (() => Response)[], models?: Readonly<Record<string, string>>) {
  const calls: { url: string; body: unknown }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined });
    const next = responses.shift();
    assert.ok(next !== undefined, `unexpected request to ${url}`);
    return next();
  }) as typeof globalThis.fetch;
  const provider = createMinimaxProvider({
    instance: "minimax.test", pool: "minimax.test",
    apiKey: credentialRef("env", "MINIMAX_API_KEY"), fetch: fetcher,
    ...(models === undefined ? {} : { models }),
  });
  const registry = new EndpointRegistry();
  provider.install(registry);
  return { calls, registry };
}

function endpointOf(registry: EndpointRegistry, want: Need): AsyncEndpoint {
  const resolution = registry.resolve(want);
  assert.equal(resolution.status, "resolved");
  if (resolution.status !== "resolved" || resolution.registration.kind !== "asynchronous") {
    throw new Error(`expected an asynchronous Endpoint, got ${resolution.status}`);
  }
  return resolution.registration.endpoint;
}

function contextFor(want: Need, resources: MemoryResourceStore, progress: string[]) {
  return {
    need: want, command: { kind: "fulfill-need", id: "c1", need: want }, operation: "op1",
    resources, credentials: { apiKey: { secret: "test-key" } },
    checkpoint: async () => { /* the caller asserts on the returned handle instead */ },
    reportProgress: async (value: { phase: string }) => { progress.push(value.phase); },
  } as unknown as EndpointStartContext;
}
type EndpointStartContext = EndpointInvocationContext & { operation: string };

test("the Endpoint serves hailuo-i2v as an asynchronous capability", () => {
  const { registry } = harness([]);
  const resolution = registry.resolve(need({}));
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.registration.kind, "asynchronous");
});

test("start submits the frame-guided body and hands back a task id", async () => {
  const { calls, registry } = harness([
    () => new Response(JSON.stringify({ task_id: "task-42", base_resp: { status_code: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const want = need({});
  const started = await endpointOf(registry, want).start!(contextFor(want, new MemoryResourceStore(), []));
  assert.equal(started.status, "pending");
  assert.deepEqual(calls[0]?.url, "https://api.minimaxi.com/v1/video_generation");
  assert.deepEqual(calls[0]?.body, {
    model: "MiniMax-Hailuo-2.3", prompt: "a boy glides forward",
    duration: 6, resolution: "768P", prompt_optimizer: false,
  });
  assert.deepEqual(started.receipt, { id: "task-42" });
});

test("a submission the service rejects fails instead of waiting on a task that never exists", async () => {
  const { registry } = harness([
    () => new Response(JSON.stringify({
      base_resp: { status_code: 2056, status_msg: "已达到 Token Plan 用量上限" },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const want = need({});
  const started = await endpointOf(registry, want).start!(contextFor(want, new MemoryResourceStore(), []));
  assert.equal(started.status, "failed");
  assert.equal(started.status === "failed" && started.failure.code, "MINIMAX_2056");
});

test("a running task keeps waiting and a succeeded one becomes ready", async () => {
  const running = harness([
    () => new Response(JSON.stringify({ status: "Processing", base_resp: { status_code: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify({ status: "Success", file_id: "file-7", base_resp: { status_code: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const want = need({});
  const handle = canonicalize({ contract: "hypit.minimax-operation@1", taskId: "task-42", route: `${capability.module.name}@${capability.module.version}#hailuo-i2v`, startedAt: Date.now() });
  const polled = await endpointOf(running.registry, want).poll!({ ...contextFor(want, new MemoryResourceStore(), []), handle });
  assert.equal(polled.status, "pending");

  const done = await endpointOf(running.registry, want).poll!({ ...contextFor(want, new MemoryResourceStore(), []), handle });
  assert.equal(done.status, "ready");
});

test("a failed task reports the service's reason", async () => {
  const { registry } = harness([
    () => new Response(JSON.stringify({ status: "Fail", base_resp: { status_code: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const want = need({});
  const handle = canonicalize({ contract: "hypit.minimax-operation@1", taskId: "t1", route: `${capability.module.name}@${capability.module.version}#hailuo-i2v`, startedAt: Date.now() });
  const polled = await endpointOf(registry, want).poll!({ ...contextFor(want, new MemoryResourceStore(), []), handle });
  assert.equal(polled.status, "failed");
  assert.equal(polled.status === "failed" && polled.failure.code, "MINIMAX_TASK_FAILED");
});

test("collect retrieves the file and stores one video Blob", async () => {
  const { calls, registry } = harness([
    () => new Response(JSON.stringify({ file: { download_url: "https://cdn.test/v.mp4" } }),
      { status: 200, headers: { "content-type": "application/json" } }),
    () => new Response(mp4, { status: 200, headers: { "content-type": "video/mp4" } }),
  ]);
  const want = need({});
  const resources = new MemoryResourceStore();
  const handle = canonicalize({ contract: "hypit.minimax-operation@1", taskId: "t1", fileId: "file-7", route: `${capability.module.name}@${capability.module.version}#hailuo-i2v`, startedAt: Date.now() });
  const collected = await endpointOf(registry, want).collect!({ ...contextFor(want, resources, []), handle });
  assert.equal(collected.status, "completed");
  assert.match(calls[0]?.url ?? "", /\/v1\/files\/retrieve\?file_id=file-7$/);
  const stored = collected.status === "completed" ? collected.result.value : undefined;
  assert.equal(stored?.kind, "inline");
  const value = (stored?.value as { videos?: BlobRef[] } | undefined) ?? {};
  assert.equal(value.videos?.[0]?.size, mp4.byteLength);
  assert.equal(value.videos?.[0]?.mediaType, "video/mp4");
});

test("a gateway deployment addresses its own model alias on the same paths", async () => {
  const { calls, registry } = harness([
    () => new Response(JSON.stringify({ task_id: "g-1", base_resp: { status_code: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } }),
  ], { "hailuo-i2v": "mm-hailuo-gateway" });
  const want = need({});
  await endpointOf(registry, want).start!(contextFor(want, new MemoryResourceStore(), []));
  assert.deepEqual(calls[0]?.url, "https://api.minimaxi.com/v1/video_generation");
  assert.equal((calls[0]?.body as { model?: string }).model, "mm-hailuo-gateway");
});

test("the model refuses the duration and resolution pair the service rejects", () => {
  const request = sealHailuoI2vRequest({
    prompt: ["x"], duration: [10], resolution: ["1080P"], promptOptimizer: [false],
  });
  assert.throws(() => verifyHailuoI2vRequest(request), /duration 10s and resolution 1080P/);
  assert.doesNotThrow(() => verifyHailuoI2vRequest(
    sealHailuoI2vRequest({ prompt: ["x"], duration: [10], resolution: ["768P"], promptOptimizer: [false] }),
  ));
});