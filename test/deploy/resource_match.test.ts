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

// What this decides is which database a deployment writes into, so the order of
// the rules is the whole point: exact before pattern, declaration order within
// each, and — the one that matters most — no guess when a pattern is ambiguous.

import { effectiveResourceNames, matchResource } from "../../src/lib/deploy/match";
import type { DeployTarget, ExistingResource } from "../../src/lib/deploy/types";
import type { RecipeResource, RecipeResourceMatch } from "../../src/lib/recipe/types";

function resource(match?: RecipeResourceMatch): RecipeResource {
  return {
    id: "db",
    kind: "d1",
    binding: "DB",
    defaultName: "${worker}-db",
    required: true,
    label: "Database",
    ...(match === undefined ? {} : { match }),
  };
}

const account: ExistingResource[] = [
  { name: "acme-db", id: "id-acme" },
  { name: "acme-data", id: "id-data" },
  { name: "acme-data-old", id: "id-old" },
  { name: "unrelated", id: "id-unrelated" },
];

/** Stands in for the wizard's own token expansion. */
const interpolate = (template: string) => template.replace(/\$\{worker\}/g, "acme");

function run(input: { match?: RecipeResourceMatch; chosenName?: string; existing?: ExistingResource[] }) {
  return matchResource({
    resource: resource(input.match),
    chosenName: input.chosenName ?? "acme-new",
    existing: input.existing ?? account,
    interpolate,
  });
}

const typed = run({ chosenName: "acme-db", match: { names: ["acme-data"] } });
const declared = run({ match: { names: ["nope", "acme-data"] } });
const interpolated = run({ match: { names: ["${worker}-data"] } });
const patterned = run({ match: { patterns: ["acme-db"] } });
const exactBeatsPattern = run({ match: { names: ["acme-data"], patterns: ["acme-.*"] } });
const ambiguous = run({ match: { patterns: ["acme-data.*"] } });
const nothing = run({ match: { names: ["gone"], patterns: ["^missing-.*$"] } });
const bare = run({});
const anchoring = run({ match: { patterns: ["data"] } });
const orderedPatterns = run({ match: { patterns: ["unrelated", "acme-data.*"] } });
const duplicateNames = run({
  chosenName: "twin",
  existing: [
    { name: "twin", id: "id-first" },
    { name: "twin", id: "id-second" },
  ],
});
const brokenPattern = run({ match: { patterns: ["a(", "acme-db"] } });

// An adopted resource keeps its own name everywhere downstream. When it does
// not, a Worker ends up bound to one database while the var beside it names
// another — which is exactly as broken as it sounds, and silent.
const names = effectiveResourceNames({
  resourceNames: { db: "acme-new", cache: "acme-cache" },
  adopted: { db: { name: "legacy-db", id: "id-legacy" } },
} as unknown as DeployTarget);

const checks: Array<[string, boolean, string?]> = [
  ["an adopted resource's own name is the one that carries", names.db === "legacy-db", JSON.stringify(names)],
  ["a resource with nothing adopted keeps the name from the field", names.cache === "acme-cache", JSON.stringify(names)],

  [
    "the name in the field wins over anything the recipe declares",
    typed.outcome === "adopt" && typed.adopt?.id === "id-acme" && typed.via === "chosen",
    JSON.stringify(typed),
  ],
  [
    "a declared name is taken in the order it is declared",
    declared.outcome === "adopt" && declared.adopt?.id === "id-data" && declared.via === "declared",
    JSON.stringify(declared),
  ],
  [
    "a declared name is interpolated before it is compared",
    interpolated.outcome === "adopt" && interpolated.adopt?.id === "id-data",
    JSON.stringify(interpolated),
  ],
  [
    "a pattern that matches one thing adopts it",
    patterned.outcome === "adopt" && patterned.adopt?.id === "id-acme" && patterned.via === "pattern",
    JSON.stringify(patterned),
  ],
  [
    "an exact name is preferred over a pattern that would also match",
    exactBeatsPattern.outcome === "adopt" && exactBeatsPattern.adopt?.id === "id-data" && exactBeatsPattern.via === "declared",
    JSON.stringify(exactBeatsPattern),
  ],
  [
    "a pattern matching several things adopts none of them",
    ambiguous.outcome === "ambiguous" && (ambiguous.candidates || []).length === 2 && ambiguous.adopt === undefined,
    JSON.stringify(ambiguous),
  ],
  [
    "the ambiguous candidates are the ones that matched",
    (ambiguous.candidates || []).map((entry) => entry.id).sort().join(",") === "id-data,id-old",
    JSON.stringify(ambiguous.candidates),
  ],
  ["nothing matching means a new one is created", nothing.outcome === "create", JSON.stringify(nothing)],
  ["a resource with no match declaration still creates", bare.outcome === "create", JSON.stringify(bare)],
  [
    "a pattern is matched whole, not as a substring",
    anchoring.outcome === "create",
    JSON.stringify(anchoring),
  ],
  [
    "patterns are tried in declaration order",
    orderedPatterns.outcome === "adopt" && orderedPatterns.adopt?.id === "id-unrelated",
    JSON.stringify(orderedPatterns),
  ],
  [
    "a duplicated name resolves to the same one every time",
    duplicateNames.outcome === "adopt" && duplicateNames.adopt?.id === "id-first",
    JSON.stringify(duplicateNames),
  ],
  [
    "a pattern that cannot compile is skipped rather than fatal",
    brokenPattern.outcome === "adopt" && brokenPattern.adopt?.id === "id-acme",
    JSON.stringify(brokenPattern),
  ],
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
