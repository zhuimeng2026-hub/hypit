import assert from "node:assert/strict";
import test from "node:test";
import { assertMappingCoversPorts } from "@hypit/generation";
import type { BlobRef, CanonicalValue } from "@hypit/protocol";
import { minimaxImage01Ports, sealMinimaxImage01Request } from "@hypit/minimax-image";
import { hailuoI2vPorts } from "@hypit/minimax-hailuo";

import { minimaxMappings } from "../src/mapping.js";
import { createMinimaxRoutes } from "../src/routes.js";
import { minimaxRouteForCapability } from "../src/routes.js";

const character: BlobRef = { kind: "blob", resource: "res_mm_1", size: 3, mediaType: "image/jpeg" };
const resolve = async (artifact: { resource: string }) => `https://example.test/${artifact.resource}`;
const constraints = (request: unknown) => request as CanonicalValue;
const routes = createMinimaxRoutes();
const route = () => minimaxRouteForCapability({
  module: { name: "@hypit/minimax-image", version: "1" }, name: "image-01",
}, routes)!;

test("every MiniMax mapping covers its model's ports", () => {
  const tables = { "image-01": minimaxImage01Ports, "hailuo-i2v": hailuoI2vPorts };
  for (const mapping of minimaxMappings) {
    assertMappingCoversPorts(tables[mapping.capability.name as keyof typeof tables], mapping);
  }
});

test("a deployment can address a gateway's own model aliases without touching mappings", () => {
  const native = createMinimaxRoutes();
  const relayed = createMinimaxRoutes({ "image-01": "mm-image-via-gateway", "hailuo-i2v": "mm-i2v-via-gateway" });
  const pick = (list: ReturnType<typeof createMinimaxRoutes>, name: string) =>
    minimaxRouteForCapability({ module: { name: "@hypit/minimax-image", version: "1" }, name }, list) ??
    minimaxRouteForCapability({ module: { name: "@hypit/minimax-hailuo", version: "1" }, name: "hailuo-i2v" }, list);

  assert.equal(pick(native, "image-01")?.routes[0]?.model, "image-01");
  assert.equal(pick(native, "hailuo-i2v")?.routes[0]?.model, "MiniMax-Hailuo-2.3");
  assert.equal(pick(relayed, "image-01")?.routes[0]?.model, "mm-image-via-gateway");
  assert.equal(pick(relayed, "hailuo-i2v")?.routes[0]?.model, "mm-i2v-via-gateway");

  const request = sealMinimaxImage01Request({
    prompt: ["x"], aspectRatio: ["1:1"], n: [1], responseFormat: ["url"], promptOptimizer: [false],
  });
  assert.equal(pick(relayed, "image-01")!.prepare(constraints(request)).model, "mm-image-via-gateway");
});

test("authored ports become the service's own wire field names", async () => {
  const request = sealMinimaxImage01Request({
    prompt: ["a red cube"], aspectRatio: ["16:9"], n: [2],
    responseFormat: ["url"], promptOptimizer: [false],
  });
  assert.deepEqual(await route().prepare(constraints(request)).compile(resolve), {
    model: "image-01", prompt: "a red cube", aspect_ratio: "16:9", n: 2,
    response_format: "url", prompt_optimizer: false,
  });
});

test("a character reference becomes a typed object holding an image_file", async () => {
  const request = sealMinimaxImage01Request({
    prompt: ["the same boy"], aspectRatio: ["16:9"], n: [1],
    responseFormat: ["url"], promptOptimizer: [false],
    subjectReference: [{ role: "image", artifact: character, fields: { type: "character" } }],
  });
  assert.deepEqual(await route().prepare(constraints(request)).compile(resolve), {
    model: "image-01", prompt: "the same boy", aspect_ratio: "16:9", n: 1,
    response_format: "url", prompt_optimizer: false,
    subject_reference: [{ type: "character", image_file: "https://example.test/res_mm_1" }],
  });
});

test("an unused subjectReference never reaches the wire", async () => {
  const request = sealMinimaxImage01Request({
    prompt: ["plain"], aspectRatio: ["1:1"], n: [1],
    responseFormat: ["base64"], promptOptimizer: [true],
  });
  const input = await route().prepare(constraints(request)).compile(resolve);
  assert.equal("subject_reference" in input, false);
});

test("the service's own limits are refused before a Build spends anything", () => {
  const base = {
    prompt: ["x"], aspectRatio: ["16:9"] as const, n: [1] as const,
    responseFormat: ["url"] as const, promptOptimizer: [false] as const,
  };
  const ask = (ports: Record<string, unknown>) => route().supports({
    capability: route().capability, returns: route().returns,
    constraints: constraints(sealMinimaxImage01Request({ ...base, ...ports } as never)),
  });
  assert.equal(ask({ n: [9] }).status, "supported");
  assert.equal(ask({}).status, "supported");
  // Both limits are enforced one layer earlier, by the Model's own port table at
  // admission. The Provider repeats them in `supports` only so a Profile that
  // offers this capability refuses with a service-specific reason rather than a
  // bare schema error; nothing reaches a paid call either way.
  assert.throws(() => sealMinimaxImage01Request({ ...base, n: [12] }), /must be at most 9/);
  assert.throws(
    () => sealMinimaxImage01Request({ ...base, responseFormat: ["b64_json"] }),
    /must be one of url, base64/,
  );
});

test("the Provider names its own limit when one reaches it anyway", () => {
  const request = sealMinimaxImage01Request({
    prompt: ["x"], aspectRatio: ["16:9"], n: [1],
    responseFormat: ["url"], promptOptimizer: [false],
  });
  // Bypassing the Model's validator to prove the service-facing reason exists.
  const forged = { ports: { ...request.ports, n: [12] } };
  const support = route().supports({
    capability: route().capability, returns: route().returns, constraints: constraints(forged),
  });
  assert.equal(support.status, "unsupported");
  assert.match(
    (support as { reason: string }).reason,
    /renders between 1 and 9 pictures/,
  );
});