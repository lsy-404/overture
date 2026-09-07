// SPDX-License-Identifier: AGPL-3.0-or-later

import { FIXED_AUTHORIZATION_DISPLAY_ROWS, deploymentAuthorizationDisplayRows } from "../../src/lib/analyze/authorizationDisplay";
import { hostEndpointsFor } from "../../src/lib/analyze/endpoints";
import { ENDPOINT_PERMISSIONS } from "../../src/lib/analyze/permissions";
import type { Recipe } from "../../src/lib/recipe/types";

const baseRecipe = { resources: [], checks: [], worker: {}, capabilities: [] } as Recipe;
const allFeaturesRecipe = {
  ...baseRecipe,
  capabilities: ["worker"],
  resources: [{ kind: "d1" }, { kind: "r2" }, { kind: "kv" }],
  turnstiles: [{ secret: { target: "workerSecret" } }],
  worker: { containers: [{ image: "registry.example/image" }] },
} as Recipe;

const fixedEndpoints = new Set(FIXED_AUTHORIZATION_DISPLAY_ROWS.flatMap((row) => row.endpointIds));
const workerRows = deploymentAuthorizationDisplayRows(hostEndpointsFor({ ...baseRecipe, capabilities: ["worker"] } as Recipe));
const d1Rows = deploymentAuthorizationDisplayRows(hostEndpointsFor({ ...baseRecipe, resources: [{ kind: "d1" }] } as Recipe));
const displayedEndpoints = new Set([
  ...fixedEndpoints,
  ...deploymentAuthorizationDisplayRows(hostEndpointsFor(allFeaturesRecipe)).flatMap((row) => row.endpointIds),
]);
const scopedHostEndpoints = hostEndpointsFor(allFeaturesRecipe).filter((id) => (ENDPOINT_PERMISSIONS[id]?.scopes.length || 0) > 0);

const checks: Array<[string, boolean, string?]> = [
  ["account and existing Worker reads are the fixed Overture rows", JSON.stringify([...fixedEndpoints].sort()) === JSON.stringify([
    "account.read", "worker.deploymentList", "worker.scriptList", "worker.scriptRead", "worker.settingsRead",
  ])],
  ["workers.dev activation is separate from the fixed Worker reads", workerRows.some((row) => row.id === "workersDev") && !FIXED_AUTHORIZATION_DISPLAY_ROWS.some((row) => row.id === "workersDev")],
  ["a D1 inventory read appears only for a D1 deployment", d1Rows.some((row) => row.id === "d1Inventory") && !deploymentAuthorizationDisplayRows(hostEndpointsFor(baseRecipe)).some((row) => row.id === "d1Inventory")],
  ["every scoped host operation has a human-facing display row", scopedHostEndpoints.every((id) => displayedEndpoints.has(id)), scopedHostEndpoints.filter((id) => !displayedEndpoints.has(id)).join(", ")],
];

let failures = 0;
for (const [label, passed, detail] of checks) {
  if (passed) console.log(`PASS ${label}`);
  else {
    failures++;
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
if (failures) process.exit(1);
