// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Administrator credentials are initial values for a new Worker, but an
// overwrite changes them only after the operator explicitly requests a reset.

import { createPinia, setActivePinia } from "pinia";
import { useWizard } from "../../src/stores/wizard";
import type { LoadedConfig } from "../../src/lib/package/config";
import type { Recipe } from "../../src/lib/recipe/types";
import { PACKAGE_ARTIFACT_NAME } from "../../shared/package";

const recipe: Recipe = {
  schema: 2,
  id: "demo",
  name: "Demo",
  summary: "A demo package",
  issues: { url: "https://github.com/acme/demo/issues/new" },
  version: "1.0.0",
  tag: "v1.0.0",
  buildTime: "2026-01-01T00:00:00Z",
  package: { artifact: PACKAGE_ARTIFACT_NAME, sha256: "a".repeat(64) },
  license: { id: "AGPL-3.0-or-later", text: "Full licence text." },
  authModes: ["auto"],
  permissions: [],
  resources: [],
  worker: { defaultName: "demo", module: "worker/index.js" },
  capabilities: [],
  inputs: [
    { id: "reset_admin", kind: "toggle", onlyMode: "overwrite", label: "Reset administrator" },
    { id: "admin_username", kind: "text", default: "admin", label: "Administrator username", visibleWhen: { input: "reset_admin", equals: true, mode: "overwrite" } },
    { id: "admin_password", kind: "password", label: "Administrator password", visibleWhen: { input: "reset_admin", equals: true, mode: "overwrite" } },
  ],
  steps: [{ id: "upload", label: "Upload" }],
};

const config: LoadedConfig = {
  ref: { owner: "acme", repo: "demo" },
  tag: "v1.0.0",
  recipe,
  licenseText: "",
  termsText: "",
};

function ids(wizard: ReturnType<typeof useWizard>) {
  return wizard.activeInputs.map((input) => input.id).join(",");
}

setActivePinia(createPinia());
const wizard = useWizard();
wizard.adoptConfig(config);
const freshShowsInitialCredentials = ids(wizard) === "admin_username,admin_password";

wizard.applyLive({ exists: true, vars: {}, crons: [], customDomains: [], containerClasses: [] });
const overwriteHidesCredentialsUntilReset = ids(wizard) === "reset_admin";

wizard.inputs.reset_admin = true;
const overwriteShowsCredentialsAfterReset = ids(wizard) === "reset_admin,admin_username,admin_password";
const resetTargetOnlyIncludesVisibleInputs = Object.keys(wizard.buildTarget().inputs).sort().join(",") === "admin_password,admin_username,reset_admin";

const checks: Array<[string, boolean]> = [
  ["a fresh deployment asks for initial administrator credentials", freshShowsInitialCredentials],
  ["an overwrite hides administrator credentials until reset is selected", overwriteHidesCredentialsUntilReset],
  ["selecting reset reveals administrator credentials for an overwrite", overwriteShowsCredentialsAfterReset],
  ["the deployment target receives only the visible reset inputs", resetTargetOnlyIncludesVisibleInputs],
];

let failures = 0;
for (const [label, passed] of checks) {
  if (passed) console.log(`  PASS ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}
console.log(`${checks.length - failures}/${checks.length} assertions passed`);
if (failures > 0) process.exit(1);
