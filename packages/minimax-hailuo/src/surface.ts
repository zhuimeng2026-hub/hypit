import { blobTypes } from "@hypit/hypit/blob";
import { generationPort, sealGenerationMediaBinding, sealGenerationRequestDraft } from "@hypit/generation";
import type { GenerationMediaPort } from "@hypit/generation";
import { createExactModelPrimaryGenerationFragment, exactModelMediaInputNames, exactModelTextInputName } from "@hypit/generation/model";
import type { CanonicalValue, TypeRef } from "@hypit/hypit/protocol";
import type { MarkupAttributeValue, StructuredElement, StructuredSurfaceHandler, SurfaceResolvedReference } from "@hypit/hypit/markup";
import { textTypes, verifyText } from "@hypit/hypit/text";
import { hailuoEndpoints } from "./index.js";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function sameType(a: TypeRef, b: TypeRef): boolean { return a.name === b.name && a.module.name === b.module.name && a.module.version === b.module.version; }
function exact(element: StructuredElement, allowed: readonly string[], required = allowed): void {
  const unknown = Object.keys(element.attributes).filter((name) => !allowed.includes(name));
  assert(unknown.length === 0, `${element.name} does not accept ${unknown[0]}`);
  const missing = required.filter((name) => element.attributes[name] === undefined);
  assert(missing.length === 0, `${element.name} requires ${missing.join(", ")}`);
}
function text(element: StructuredElement, name: string): string {
  const value = element.attributes[name];
  assert(typeof value === "string" && value.trim().length > 0, `${element.name}.${name} must be text`);
  return value.trim();
}
function integer(element: StructuredElement, name: string, min: number, max: number): number {
  const parsed = Number(text(element, name));
  assert(Number.isInteger(parsed), `${element.name}.${name} must be a whole number of seconds`);
  assert(parsed === 6 || parsed === 10, `${element.name}.${name} must be 6 or 10; the model accepts no other duration`);
  assert(parsed >= min && parsed <= max, `${element.name}.${name} must be between ${min} and ${max}`);
  return parsed;
}
function boolean(element: StructuredElement, name: string): boolean {
  const value = text(element, name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${element.name}.${name} must be true or false`);
}
function ref(element: StructuredElement, name: string, type: TypeRef, resolve: (path: string) => SurfaceResolvedReference | undefined): SurfaceResolvedReference {
  const value: MarkupAttributeValue | undefined = element.attributes[name];
  assert(typeof value === "object" && value.kind === "reference", `${element.name}.${name} must be a reference`);
  const result = resolve(value.path);
  assert(result !== undefined && sameType(result.type, type), `${element.name}.${name} has the wrong type`);
  return result;
}

function decoder(frameMode: boolean): StructuredSurfaceHandler {
  return ({ element, resolveReference }) => {
    exact(element, ["id", "prompt", "duration", "resolution", "prompt-optimizer", ...(frameMode ? ["first-frame", "last-frame"] : [])],
      frameMode ? ["id", "prompt", "duration", "resolution", "prompt-optimizer"] : undefined);
    const id = text(element, "id");
    const prompt = ref(element, "prompt", textTypes.text, resolveReference);
    if (prompt.record !== undefined) {
      assert(prompt.record.value.kind === "inline", `${element.name}.prompt must reference Text`);
      verifyText(prompt.record.value.value);
    }
    const endpoint = hailuoEndpoints.i2v!;
    const firstPort = generationPort(endpoint.ports, "firstFrame");
    const lastPort = generationPort(endpoint.ports, "lastFrame");
    assert(firstPort.value.kind === "media" && lastPort.value.kind === "media", "Hailuo frame ports are not media");

    const draft = sealGenerationRequestDraft(endpoint.ports, {
      duration: [integer(element, "duration", 6, 10)],
      resolution: [text(element, "resolution")],
      promptOptimizer: [boolean(element, "prompt-optimizer")],
    });
    const records: Array<{ id: string; type: TypeRef; value: { kind: "inline"; value: CanonicalValue }; range: StructuredElement["range"] }> = [{
      id: `${id}.draft`, type: endpoint.draftType, value: { kind: "inline", value: draft as unknown as CanonicalValue }, range: element.range,
    }];
    const inputs: Record<string, SurfaceResolvedReference["ref"] | { kind: "record"; id: string }> = {
      draft: { kind: "record", id: `${id}.draft` }, [exactModelTextInputName("prompt")]: prompt.ref,
    };

    const media: { name: string; port: "firstFrame" | "lastFrame" }[] = [];
    for (const [attribute, port] of [["first-frame", "firstPort"], ["last-frame", "lastPort"]] as const) {
      const value: MarkupAttributeValue | undefined = element.attributes[attribute];
      if (value === undefined) continue;
      assert(frameMode, `${element.name} does not accept ${attribute}; use FrameVideo`);
      const image = ref(element, attribute, blobTypes.blob, resolveReference);
      if (image.record !== undefined) assert(image.record.value.kind === "blob" && image.record.value.mediaType.startsWith("image/"), `${element.name}.${attribute} must be image media`);
      const portName = port === "firstPort" ? "firstFrame" : "lastFrame";
      const mediaPort = (port === "firstPort" ? firstPort : lastPort) as GenerationMediaPort;
      const name = String(portName);
      const bindingId = `${id}.${name}.binding`;
      records.push({
        id: bindingId, type: endpoint.mediaBindings[portName]!.type, range: element.range,
        value: { kind: "inline", value: sealGenerationMediaBinding(mediaPort, { role: "image" }) as unknown as CanonicalValue },
      });
      const names = exactModelMediaInputNames(name);
      inputs[names.binding] = { kind: "record", id: bindingId };
      inputs[names.artifact] = image.ref;
      media.push({ name, port: portName });
    }
    assert(!frameMode || media.length >= 1,
      frameMode ? `${element.name} requires first-frame or last-frame` : `${element.name} does not accept a frame`);

    const fragment = createExactModelPrimaryGenerationFragment(endpoint, media, [{ name: "prompt", port: "prompt" }]);
    return {
      records, fragments: [fragment],
      components: [{ id, fragment: fragment.id, inputs, outputs: { video: `${id}.video` }, range: element.range }],
    };
  };
}
export const decodeHailuoTextVideoSurface = decoder(false);
export const decodeHailuoFrameVideoSurface = decoder(true);