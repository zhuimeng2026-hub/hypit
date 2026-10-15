import { createMarkupSurfaceFacet } from "@hypit/hypit/markup";
import { createAdmissionPackageFacet } from "@hypit/hypit/admission";
import { createProducerPackageFacet } from "@hypit/hypit/producer";
import { hailuoComponent, hailuoDefinition, hailuoManifest, hailuoMarkupSurfaces, minimaxHailuoModuleRef,
} from "./index.js";
import { decodeHailuoFrameVideoSurface, decodeHailuoTextVideoSurface } from "./surface.js";
export const hypitPackage = { format: "hypit.package@1" as const, modules: [{ manifest: hailuoManifest }], facets: [
  createProducerPackageFacet(hailuoComponent),
  createAdmissionPackageFacet(hailuoComponent),
  hailuoDefinition.facet,
  createMarkupSurfaceFacet({ module: minimaxHailuoModuleRef,
    declaration: hailuoMarkupSurfaces.find((item) => item.name === "text-video")!, handler: decodeHailuoTextVideoSurface }),
  createMarkupSurfaceFacet({ module: minimaxHailuoModuleRef,
    declaration: hailuoMarkupSurfaces.find((item) => item.name === "frame-video")!, handler: decodeHailuoFrameVideoSurface }),
] };
export default hypitPackage;