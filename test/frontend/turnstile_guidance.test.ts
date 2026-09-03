// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const checks: Array<[string, boolean]> = [
  ["recipe docs show both secret delivery targets", ['"turnstiles"', '"target": "recipe"', '"target": "workerSecret"', '"name": "TURNSTILE_SECRET"'].every((needle) => read("docs/RECIPE.md").includes(needle))],
  ["confirmation UI discloses interpolated widget configuration and destination", ["turnstileSummaries", "wizard.interpolate(widget.name)", "widget.domains.map((domain) => wizard.interpolate(domain))", "turnstileRecipeWarning", "turnstileSecretWorker", "widget.secret.target === 'recipe'", "widget.secret.name"].every((needle) => read("src/components/steps/StepConfirm.vue").includes(needle))],
  ["auto-token UI visibly includes the required Turnstile permission", ["key: \"challenge_widgets\"", "type: \"edit\"", "const permissionRows = computed(() => describePermissions(", "TURNSTILE_PERMISSION", "includedPermissions"].every((needle) => read("src/components/steps/StepAuthorize.vue").includes(needle))],
  ["high-risk warning exists in both locales and public docs", ["turnstileRecipeWarningBody"].every((needle) => read("src/locales/en.json").includes(needle) && read("src/locales/zh-CN.json").includes(needle)) && read("README.md").includes("turnstiles[]") && read("README.zh-CN.md").includes("turnstiles[]") && read("CONTRACT.md").includes("Turnstile delivery")],
];

let failures = 0;
for (const [label, passed] of checks) {
  if (passed) console.log(`  PASS ${label}`);
  else { failures++; console.error(`  FAIL ${label}`); }
}
console.log(`${checks.length - failures}/${checks.length} assertions passed`);
if (failures > 0) process.exit(1);
