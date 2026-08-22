// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A selected existing resource can be an old database, bucket, or namespace
// with data the app will be able to change. Its approval must therefore name
// the exact resource, and must not survive a changed choice or inventory.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createPinia, setActivePinia } from "pinia";
import { useWizard } from "../../src/stores/wizard";
import type { LoadedConfig } from "../../src/lib/package/config";
import type { Recipe } from "../../src/lib/recipe/types";
import { PACKAGE_ARTIFACT_NAME } from "../../shared/package";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const targetSource = fs.readFileSync(path.join(root, "src/components/steps/StepTarget.vue"), "utf8");

function config(): LoadedConfig {
  const recipe: Recipe = {
    schema: 2,
    id: "demo",
    name: "Demo",
    summary: "A demo package",
    version: "1.0.0",
    tag: "v1.0.0",
    buildTime: "2026-01-01T00:00:00Z",
    package: { artifact: PACKAGE_ARTIFACT_NAME, sha256: "a".repeat(64) },
    license: { id: "AGPL-3.0-or-later", text: "Full licence text." },
    authModes: ["auto"],
    permissions: [],
    resources: [{
      id: "db",
      kind: "d1",
      binding: "DB",
      defaultName: "edgesonic-db",
      required: true,
      label: "Database",
    }],
    worker: { defaultName: "demo", module: "worker/index.js" },
    capabilities: ["d1"],
    steps: [{ id: "upload", label: "Upload" }],
  };
  return { ref: { owner: "acme", repo: "demo" }, tag: "v1.0.0", recipe, licenseText: "", termsText: "" };
}

setActivePinia(createPinia());
const wizard = useWizard();
wizard.adoptConfig(config());
wizard.inventory.d1 = [
  { name: "edgesonic-db", id: "d1-original" },
  { name: "other-db", id: "d1-other" },
];

const automaticallyAdopted = wizard.adoptions.db;
const blockedBeforeApproval = wizard.unconfirmedAdoptionResourceIds.includes("db") && !wizard.isAdoptionConfirmed("db");

wizard.confirmAdoption("db", true);
const approvedExactResource = wizard.isAdoptionConfirmed("db") && wizard.unconfirmedAdoptionResourceIds.length === 0;

wizard.chooseAdoption("db", "other-db");
const changedChoiceNeedsApproval = !wizard.isAdoptionConfirmed("db") && wizard.unconfirmedAdoptionResourceIds.includes("db");

wizard.confirmAdoption("db", true);
wizard.inventory.d1 = [{ name: "other-db", id: "d1-replaced" }];
const changedIdentityNeedsApproval = !wizard.isAdoptionConfirmed("db") && wizard.unconfirmedAdoptionResourceIds.includes("db");

wizard.confirmAdoption("db", true);
wizard.touchResource("db");
const editedNameClearsApproval = !wizard.isAdoptionConfirmed("db") && wizard.unconfirmedAdoptionResourceIds.length === 0;

const checks: Array<[string, boolean, string?]> = [
  ["an existing resource is adopted from the account inventory", automaticallyAdopted?.id === "d1-original", JSON.stringify(automaticallyAdopted)],
  ["an adopted resource blocks progression until the exact resource is approved", blockedBeforeApproval],
  ["approval unlocks only the selected existing resource", approvedExactResource],
  ["choosing a different existing resource clears the prior approval", changedChoiceNeedsApproval],
  ["a changed resource identity cannot inherit an old approval", changedIdentityNeedsApproval],
  ["editing the resource name clears its approval and adoption", editedNameClearsApproval],
  ["the target page renders the required existing-resource confirmation", /unconfirmedAdoptionResourceIds/.test(targetSource) && /confirmAdoption/.test(targetSource) && /target\.adoptConfirm/.test(targetSource)],
];

let failures = 0;
for (const [label, passed, detail] of checks) {
  if (passed) console.log(`  PASS ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
console.log(`${checks.length - failures}/${checks.length} assertions passed`);
if (failures > 0) process.exit(1);
