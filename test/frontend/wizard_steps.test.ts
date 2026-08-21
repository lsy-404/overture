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

// The 9-step order (tos, repository, license, authMethod, authorize, target,
// confirm, deploy, done) is a contract between src/stores/wizard.ts's STEPS
// constant and App.vue's PAGES map — nothing at the type level catches PAGES
// missing a step or App.vue routing two steps to the same page, since
// Component values erase which STEPS key they were assigned under. This reads
// both sides.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { STEPS, TOTAL_STEPS } from "../../src/stores/wizard";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appSource = fs.readFileSync(path.join(root, "src/App.vue"), "utf8");

/** Body of a brace-delimited declaration, from its `{` to the matching `}`. */
function blockAfter(source: string, needle: string): string {
  const at = source.indexOf(needle);
  if (at < 0) return "";
  const open = source.indexOf("{", at);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return "";
}

const EXPECTED_ORDER = ["tos", "repository", "license", "authMethod", "authorize", "target", "confirm", "deploy", "done"];

const pagesBlock = blockAfter(appSource, "const PAGES:");
const pageEntries = [...pagesBlock.matchAll(/\[STEPS\.(\w+)\]:\s*(\w+)/g)].map((match) => ({ key: match[1], component: match[2] }));
const pageKeys = pageEntries.map((entry) => entry.key);

const stepsKeys = Object.keys(STEPS);
const stepsValuesInDeclaredOrder = EXPECTED_ORDER.map((key) => STEPS[key as keyof typeof STEPS]);

const checks: Array<[string, boolean, string?]> = [
  ["STEPS declares exactly the 9-step order, nothing more or less",
    stepsKeys.length === EXPECTED_ORDER.length && EXPECTED_ORDER.every((key) => key in STEPS),
    stepsKeys.join(", ")],
  ["the 9 steps are numbered 1..9 in walking order",
    JSON.stringify(stepsValuesInDeclaredOrder) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    stepsValuesInDeclaredOrder.join(", ")],
  ["TOTAL_STEPS is the done step", TOTAL_STEPS === STEPS.done && TOTAL_STEPS === 9],
  ["repository comes before license, license before authMethod, authMethod before authorize, authorize before target",
    STEPS.repository < STEPS.license && STEPS.license < STEPS.authMethod && STEPS.authMethod < STEPS.authorize && STEPS.authorize < STEPS.target],

  ["App.vue's PAGES map was found", pageEntries.length > 0, "no `const PAGES: … = { … }` block matched in App.vue"],
  ["PAGES routes every STEPS key, none twice, none extra",
    pageKeys.length === stepsKeys.length && stepsKeys.every((key) => pageKeys.includes(key)),
    `PAGES: ${pageKeys.join(", ")}; STEPS: ${stepsKeys.join(", ")}`],
  ["PAGES routes repository/license/authMethod/authorize to their own split components",
    pageEntries.some((e) => e.key === "repository" && e.component === "StepRepository")
    && pageEntries.some((e) => e.key === "license" && e.component === "StepLicense")
    && pageEntries.some((e) => e.key === "authMethod" && e.component === "StepAuthMethod")
    && pageEntries.some((e) => e.key === "authorize" && e.component === "StepAuthorize"),
    pageEntries.map((e) => `${e.key}:${e.component}`).join(", ")],

  ["no source file still names the pre-reorder step keys",
    !/STEPS\.(version|credentials)\b/.test(appSource)],
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
