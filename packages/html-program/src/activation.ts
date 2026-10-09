import { createAdmissionPackageFacet } from "@hypit/admission";
import { createProducerPackageFacet } from "@hypit/producer";
import { htmlProgramComponent, htmlProgramManifest } from "./index.js";

export const hypitPackage = {
  format: "hypit.package@1" as const,
  modules: [{ manifest: htmlProgramManifest }],
  facets: [...[htmlProgramComponent].flatMap((component) => [createProducerPackageFacet(component), createAdmissionPackageFacet(component)])],
};
export default hypitPackage;
