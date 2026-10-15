import assert from "node:assert/strict";
import test from "node:test";

import { blobTypes } from "@hypit/blob";
import { parseStructuredElement } from "@hypit/markup";
import type { StructuredSurfaceHandler, SurfaceResolvedReference } from "@hypit/markup";
import { textTypes } from "@hypit/text";

import {
  decodeMinimaxImageCharacterImageSurface,
  decodeMinimaxImageTextImageSurface,
} from "../src/surface.js";

const refs = new Map<string, SurfaceResolvedReference>([
  ["prompt", {
    path: "prompt",
    ref: { kind: "component-output", component: "assembled-prompt", output: "text" },
    type: textTypes.text,
  }],
  ...["hero.image", "second.image"].map((path) => [path, {
    path,
    ref: { kind: "component-output" as const, component: path.split(".")[0]!, output: "image" },
    type: blobTypes.blob,
  }] as const),
]);

async function decode(source: string, handler: StructuredSurfaceHandler) {
  const element = parseStructuredElement({ name: "minimax-image.svml", text: source }, 0).element;
  return await handler({
    sourceName: "minimax-image.svml",
    element,
    resolveReference: (path) => refs.get(path),
    resolveAsset: () => { throw new Error("no asset"); },
  });
}

const authored = `<minimax-image:TextImage id="scene" prompt={prompt}
  aspect-ratio="16:9" n="2" response-format="url" prompt-optimizer="false"/>`;

test("authored image-01 fields reach the draft unchanged", async () => {
  const result = await decode(authored, decodeMinimaxImageTextImageSurface);
  const component = result.components[0]!;
  assert.equal(component.id, "scene");
  assert.deepEqual(component.outputs, { image: "scene.image" });

  const draft = result.records.find((record) => record.id === "scene.draft");
  assert.equal(draft?.value.kind, "inline");
  assert.deepEqual((draft?.value.value as { ports?: unknown }).ports, {
    aspectRatio: ["16:9"],
    n: [2],
    responseFormat: ["url"],
    promptOptimizer: [false],
  });
});

test("the prompt stays an explicit graph edge and no media is copied", async () => {
  const result = await decode(authored, decodeMinimaxImageTextImageSurface);
  assert.deepEqual(result.components[0]!.inputs["prompt:text"], {
    kind: "component-output", component: "assembled-prompt", output: "text",
  });
});

test("generation emits the documented operation chain", async () => {
  const result = await decode(authored, decodeMinimaxImageTextImageSurface);
  assert.deepEqual(result.fragments[0]?.operations.map((operation) => operation.id), [
    "bind-text:0001:prompt", "finalize-request", "generate", "select-primary-image",
  ]);
});

test("a text-only element rejects a Character child", async () => {
  const source = `<minimax-image:TextImage id="scene" prompt={prompt}
    aspect-ratio="16:9" n="1" response-format="url" prompt-optimizer="false">
    <minimax-image:Character image={hero.image}/>
  </minimax-image:TextImage>`;
  await assert.rejects(() => decode(source, decodeMinimaxImageTextImageSurface), /accepts no such child/);
});

test("a character element requires at least one Character", async () => {
  const source = `<minimax-image:CharacterImage id="hero" prompt={prompt}
    aspect-ratio="16:9" n="1" response-format="url" prompt-optimizer="false"/>`;
  await assert.rejects(() => decode(source, decodeMinimaxImageCharacterImageSurface), /requires at least one Character/);
});

test("each character reference stays a graph edge and is bound as a character", async () => {
  const source = `<minimax-image:CharacterImage id="hero" prompt={prompt}
    aspect-ratio="16:9" n="1" response-format="url" prompt-optimizer="false">
    <minimax-image:Character image={hero.image}/>
    <minimax-image:Character image={second.image}/>
  </minimax-image:CharacterImage>`;
  const result = await decode(source, decodeMinimaxImageCharacterImageSurface);
  const component = result.components[0]!;
  assert.deepEqual(component.inputs["character-0001:artifact"], {
    kind: "component-output", component: "hero", output: "image",
  });
  assert.deepEqual(component.inputs["character-0002:artifact"], {
    kind: "component-output", component: "second", output: "image",
  });
  const binding = result.records.find((record) => record.id === "hero.character-0001.binding");
  assert.equal(binding?.value.kind, "inline");
  assert.deepEqual((binding?.value.value as unknown), { role: "image", fields: { type: "character" } });
});

test("a non-integer n is rejected before any Provider is chosen", async () => {
  const source = `<minimax-image:TextImage id="scene" prompt={prompt}
    aspect-ratio="16:9" n="many" response-format="url" prompt-optimizer="false"/>`;
  await assert.rejects(() => decode(source, decodeMinimaxImageTextImageSurface), /must be a whole number/);
});