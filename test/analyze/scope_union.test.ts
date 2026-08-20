// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// What an authorize request actually asks Cloudflare for — the union of the
// package's own `permissions[].oauthScopes` and Overture's own baseline
// (`scopesForEndpoints(hostEndpointsFor(recipe))`) — mirroring the same
// computation src/stores/wizard.ts exposes as `requestedScope`. Exercised here
// against the pure functions it is built from, rather than through Pinia,
// since nothing about the union depends on reactivity.

import { hostEndpointsFor } from "../../src/lib/analyze/endpoints";
import { scopesForEndpoints } from "../../src/lib/analyze/permissions";
import { validateRecipe } from "../../src/lib/recipe/schema";
import type { Recipe } from "../../src/lib/recipe/types";
import { PACKAGE_ARTIFACT_NAME } from "../../shared/package";

function recipe(overrides: Record<string, unknown> = {}): Recipe {
  const base = {
    schema: 2,
    id: "demo",
    name: "Demo",
    summary: { "*": "A demo package" },
    version: "1.0.0",
    tag: "v1.0.0",
    buildTime: "2026-01-01T00:00:00Z",
    package: { artifact: PACKAGE_ARTIFACT_NAME, sha256: "a".repeat(64) },
    license: { id: "AGPL-3.0-or-later", text: "Licence text." },
    permissions: [
      {
        key: "database",
        requirement: "required",
        oauthScopes: ["d1.write", "d1.read"],
        label: { "*": "D1 database" },
        scenario: { "*": "Create and query the database" },
        scope: "account",
        level: "write",
      },
    ],
    resources: [{ id: "db", kind: "d1", binding: "DB", defaultName: "${worker}-db", required: true, label: { "*": "Database" } }],
    worker: { defaultName: "demo", module: "worker/index.js" },
    capabilities: ["d1"],
    steps: [{ id: "schema", label: { "*": "Create the schema" } }],
    ...overrides,
  };
  const validated = validateRecipe(base);
  if (!validated.ok) throw new Error(`fixture is not a valid recipe: ${validated.errors.join("; ")}`);
  return validated.recipe;
}

/** wizard.ts's `appRequestedScope`, `hostBaselineScope` and `requestedScope`, reproduced. */
function appRequestedScope(r: Recipe): string[] {
  const out = new Set<string>();
  for (const permission of r.permissions) for (const scope of permission.oauthScopes) out.add(scope);
  return [...out].sort();
}
function hostBaselineScope(r: Recipe): string[] {
  return scopesForEndpoints(hostEndpointsFor(r));
}
function requestedScope(r: Recipe): string[] {
  return [...new Set([...appRequestedScope(r), ...hostBaselineScope(r)])].sort();
}

const withOverlap = recipe(); // "d1.write"/"d1.read" self-reported, host baseline reaches account-settings.read etc.
const withoutResources = recipe({ resources: [], capabilities: [] });
const withDuplicateReport = recipe({
  permissions: [
    { key: "a", requirement: "required", oauthScopes: ["d1.write"], label: { "*": "a" }, scenario: { "*": "a" }, scope: "account", level: "write" },
    { key: "b", requirement: "optional", oauthScopes: ["d1.write", "account-settings.read"], label: { "*": "b" }, scenario: { "*": "b" }, scope: "account", level: "read" },
  ],
});

const checks: Array<[string, boolean, string?]> = [
  ["the app's own scopes are exactly its permissions' oauthScopes, deduplicated",
    appRequestedScope(withOverlap).join(" ") === ["d1.read", "d1.write"].join(" "),
    appRequestedScope(withOverlap).join(" ")],
  ["the host baseline always covers account.read regardless of what the package declares",
    hostBaselineScope(withOverlap).includes("account-settings.read") && hostBaselineScope(withoutResources).includes("account-settings.read")],
  ["a recipe with no d1 resources does not request d1 read/write in the host baseline",
    !hostBaselineScope(withoutResources).includes("d1.read") && !hostBaselineScope(withoutResources).includes("d1.write")],
  ["the requested set is a superset of both the app's own scopes and the host baseline",
    appRequestedScope(withOverlap).every((scope) => requestedScope(withOverlap).includes(scope))
    && hostBaselineScope(withOverlap).every((scope) => requestedScope(withOverlap).includes(scope))],
  ["a scope named in both the app's own report and the host baseline appears once in the union",
    requestedScope(withOverlap).filter((scope) => scope === "d1.write").length === 1],
  ["duplicate oauthScopes across permission rows collapse in the app's own set",
    appRequestedScope(withDuplicateReport).filter((scope) => scope === "d1.write").length === 1,
    appRequestedScope(withDuplicateReport).join(" ")],
  ["the union is sorted and carries no duplicate",
    JSON.stringify(requestedScope(withOverlap)) === JSON.stringify([...new Set(requestedScope(withOverlap))].sort())],
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
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
