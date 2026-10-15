import { blobTypes } from "@hypit/hypit/blob";
import { generationPort, sealGenerationMediaBinding, sealGenerationRequestDraft } from "@hypit/generation";
import type { GenerationMediaPort } from "@hypit/generation";
import { createExactModelPrimaryGenerationFragment, exactModelMediaInputNames, exactModelTextInputName } from "@hypit/generation/model";
import type { CanonicalValue, TypeRef } from "@hypit/hypit/protocol";
import type { MarkupAttributeValue, StructuredElement, StructuredSurfaceHandler, SurfaceResolvedReference } from "@hypit/hypit/markup";
import { textTypes, verifyText } from "@hypit/hypit/text";
import { minimaxImageEndpoints } from "./index.js";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function localName(name: string): string { return name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name; }
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
function boolean(element: StructuredElement, name: string): boolean {
  const value = text(element, name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${element.name}.${name} must be true or false`);
}
function integer(element: StructuredElement, name: string): number {
  const value = text(element, name);
  const parsed = Number(value);
  assert(Number.isInteger(parsed), `${element.name}.${name} must be a whole number`);
  return parsed;
}
function ref(element: StructuredElement, name: string, type: TypeRef, resolve: (path: string) => SurfaceResolvedReference | undefined): SurfaceResolvedReference {
  const value: MarkupAttributeValue | undefined = element.attributes[name];
  assert(typeof value === "object" && value.kind === "reference", `${element.name}.${name} must be a reference`);
  const result = resolve(value.path);
  assert(result !== undefined && sameType(result.type, type), `${element.name}.${name} has the wrong type`);
  return result;
}

function decoder(characterMode: boolean): StructuredSurfaceHandler {
  return ({ element, resolveReference }) => {
    exact(element, ["id", "prompt", "aspect-ratio", "n", "response-format", "prompt-optimizer"]);
    const id = text(element, "id");
    const prompt = ref(element, "prompt", textTypes.text, resolveReference);
    if (prompt.record !== undefined) {
      assert(prompt.record.value.kind === "inline", `${element.name}.prompt must reference Text`);
      verifyText(prompt.record.value.value);
    }
    const endpoint = minimaxImageEndpoints.image!;
    const characterPort = generationPort(endpoint.ports, "subjectReference");
    assert(characterPort.value.kind === "media", "MiniMax image-01 subjectReference port is not media");
    const characters: SurfaceResolvedReference[] = [];
    for (const child of element.children) {
      if (child.kind === "text") { assert(child.value.trim().length === 0, `${element.name} accepts only Character children`); continue; }
      assert(characterMode && localName(child.name) === "Character", `${element.name} accepts no such child`);
      exact(child, ["image"]);
      assert(!child.children.some((item) => item.kind === "element" || item.value.trim()), `${child.name} must be empty`);
      const image = ref(child, "image", blobTypes.blob, resolveReference);
      if (image.record !== undefined) assert(image.record.value.kind === "blob" && image.record.value.mediaType.startsWith("image/"), `${child.name}.image must be image media`);
      characters.push(image);
    }
    assert(characterMode ? characters.length >= 1 : characters.length === 0,
      characterMode ? `${element.name} requires at least one Character` : `${element.name} does not accept Characters`);
    assert(characters.length <= characterPort.maxItems, `${element.name} accepts at most ${characterPort.maxItems} Characters`);
    const draft = sealGenerationRequestDraft(endpoint.ports, {
      aspectRatio: [text(element, "aspect-ratio")],
      n: [integer(element, "n")],
      responseFormat: [text(element, "response-format")],
      promptOptimizer: [boolean(element, "prompt-optimizer")],
    });
    const records: Array<{ id: string; type: TypeRef; value: { kind: "inline"; value: CanonicalValue }; range: StructuredElement["range"] }> = [{
      id: `${id}.draft`, type: endpoint.draftType, value: { kind: "inline", value: draft as unknown as CanonicalValue }, range: element.range,
    }];
    const inputs: Record<string, SurfaceResolvedReference["ref"] | { kind: "record"; id: string }> = {
      draft: { kind: "record", id: `${id}.draft` }, [exactModelTextInputName("prompt")]: prompt.ref,
    };
    const media = characters.map((image, index) => {
      const name = `character-${String(index + 1).padStart(4, "0")}`; const bindingId = `${id}.${name}.binding`;
      records.push({
        id: bindingId, type: endpoint.mediaBindings.subjectReference!.type, range: element.range,
        value: {
          kind: "inline",
          value: sealGenerationMediaBinding(characterPort as GenerationMediaPort, {
            role: "image",
            fields: { type: "character" },
          }) as unknown as CanonicalValue,
        },
      });
      const names = exactModelMediaInputNames(name); inputs[names.binding] = { kind: "record", id: bindingId }; inputs[names.artifact] = image.ref;
      return { name, port: "subjectReference" } as const;
    });
    const fragment = createExactModelPrimaryGenerationFragment(endpoint, media, [{ name: "prompt", port: "prompt" }]);
    return { records, fragments: [fragment], components: [{ id, fragment: fragment.id, inputs, outputs: { image: `${id}.image` }, range: element.range }] };
  };
}
export const decodeMinimaxImageTextImageSurface = decoder(false);
export const decodeMinimaxImageCharacterImageSurface = decoder(true);