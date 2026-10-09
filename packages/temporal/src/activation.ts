import { createAdmissionPackageFacet } from "@hypit/admission";
import { createProducerPackageFacet } from "@hypit/producer";
import { temporalManifest } from "./index.js";
import { temporalComponent } from "./component.js";

export const hypitPackage = {
  format: "hypit.package@1" as const,
  modules: [{ manifest: temporalManifest }],
  facets: [...[temporalComponent].flatMap((component) => [createProducerPackageFacet(component), createAdmissionPackageFacet(component)])],
};
export default hypitPackage;
