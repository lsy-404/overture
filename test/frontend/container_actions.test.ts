// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createPinia, setActivePinia } from "pinia";
import { useWizard } from "../../src/stores/wizard";
import type { LoadedConfig } from "../../src/lib/package/config";
import type { Recipe } from "../../src/lib/recipe/types";
import { PACKAGE_ARTIFACT_NAME } from "../../shared/package";

const recipe: Recipe = {
  schema: 2, id: "demo", name: "Demo", summary: "Demo", issues: { url: "https://github.com/acme/demo/issues/new" }, version: "1.0.0", tag: "v1.0.0", buildTime: "2026-01-01T00:00:00Z",
  package: { artifact: PACKAGE_ARTIFACT_NAME, sha256: "a".repeat(64) }, license: { id: "AGPL-3.0-or-later", text: "Licence" },
  authModes: ["auto"], permissions: [], resources: [], capabilities: [], steps: [{ id: "upload", label: "Upload" }],
  worker: {
    defaultName: "demo", module: "worker/index.js",
    containers: [
      { className: "Sandbox", mode: "ask", image: { reference: `docker.io/acme/demo@sha256:${"a".repeat(64)}` } },
      { className: "Legacy", mode: "ask" },
      { className: "Required", mode: "always", image: { reference: `docker.io/acme/required@sha256:${"b".repeat(64)}` } },
    ],
  },
};
const config: LoadedConfig = { ref: { owner: "acme", repo: "demo" }, tag: "v1.0.0", recipe, licenseText: "", termsText: "" };

setActivePinia(createPinia());
const wizard = useWizard();
wizard.adoptConfig(config);
const freshDefaults = wizard.containerActions.Sandbox === "off" && wizard.containerActions.Legacy === "off" && wizard.containerActions.Required === "on";
const freshTarget = wizard.buildTarget();
const freshDeclaration = freshTarget.declareContainers.join(",") === "Required" && freshTarget.containerActions?.Legacy === "off";

wizard.applyLive({ exists: true, vars: {}, crons: [], customDomains: [], containerClasses: ["Sandbox", "Legacy", "Required"] });
const overwriteDefaults = wizard.containerActions.Sandbox === "unchanged" && wizard.containerActions.Legacy === "unchanged" && wizard.containerActions.Required === "on";
const unchangedPreservesLive = wizard.declareContainers.join(",") === "Sandbox,Legacy,Required";

wizard.containerActions.Sandbox = "off";
const offExcludes = !wizard.declareContainers.includes("Sandbox") && wizard.buildTarget().containerActions?.Sandbox === "off";
wizard.containerActions.Sandbox = "on";
const onDeclares = wizard.declareContainers.includes("Sandbox") && wizard.buildTarget().containerActions?.Sandbox === "on";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const targetSource = fs.readFileSync(path.join(root, "src/components/steps/StepTarget.vue"), "utf8");
const uiUsesThreeStates = /value="unchanged"/.test(targetSource) && /v-if="container\.image" value="on"/.test(targetSource) && /value="off"/.test(targetSource);
const uiExplainsUnavailableImage = /target\.containerUnavailable/.test(targetSource);

const checks: Array<[string, boolean]> = [
  ["fresh defaults optional containers off and required containers on", freshDefaults],
  ["fresh target excludes an optional disabled container", freshDeclaration],
  ["overwrite defaults an existing optional declaration to unchanged", overwriteDefaults],
  ["unchanged preserves the live declaration", unchangedPreservesLive],
  ["off excludes the class from the Worker version", offExcludes],
  ["on declares the class and reaches the host action", onDeclares],
  ["target UI presents unchanged, on and off", uiUsesThreeStates],
  ["target UI explains why a container without an image cannot be enabled", uiExplainsUnavailableImage],
];

let failures = 0;
for (const [label, passed] of checks) {
  if (passed) console.log(`PASS ${label}`);
  else { failures += 1; console.error(`FAIL ${label}`); }
}
if (failures) process.exit(1);
