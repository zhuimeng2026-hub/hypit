import { createMarkupSurfaceFacet } from "@hypit/hypit/markup";
import { createAdmissionPackageFacet } from "@hypit/hypit/admission";
import { createProducerPackageFacet } from "@hypit/hypit/producer";
import { minimaxImageComponent, minimaxImageDefinition, minimaxImageManifest, minimaxImageModuleRef,
  minimaxImageMarkupSurfaces } from "./index.js";
import { decodeMinimaxImageCharacterImageSurface, decodeMinimaxImageTextImageSurface } from "./surface.js";
export const hypitPackage = { format: "hypit.package@1" as const, modules: [{ manifest: minimaxImageManifest }], facets: [
  createProducerPackageFacet(minimaxImageComponent),
  createAdmissionPackageFacet(minimaxImageComponent),
  minimaxImageDefinition.facet,
  createMarkupSurfaceFacet({ module: minimaxImageModuleRef,
    declaration: minimaxImageMarkupSurfaces.find((item) => item.name === "text-image")!, handler: decodeMinimaxImageTextImageSurface }),
  createMarkupSurfaceFacet({ module: minimaxImageModuleRef,
    declaration: minimaxImageMarkupSurfaces.find((item) => item.name === "character-image")!, handler: decodeMinimaxImageCharacterImageSurface }),
] };
export default hypitPackage;