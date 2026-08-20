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

// The footer's build identity is substituted at build time, so a mistake there
// is invisible to every other test: the app still compiles and runs, it just
// tells the user the wrong thing about which build they are looking at — or
// prints the placeholder itself. Asserted against the built output, since that
// is the only place the substitution has actually happened.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const ASSETS = join(ROOT, "dist", "assets");

const checks: Array<[string, boolean, string?]> = [];

if (!existsSync(ASSETS)) {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
}

const bundle = readdirSync(ASSETS)
  .filter((name) => name.endsWith(".js"))
  .map((name) => readFileSync(join(ASSETS, name), "utf8"))
  .join("\n");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const placeholders = ["__BUILD_VERSION__", "__BUILD_COMMIT__", "__BUILD_REPOSITORY__"].filter((name) =>
  bundle.includes(name),
);

checks.push(["every build placeholder is substituted", placeholders.length === 0, placeholders.join(", ")]);
// Quote style is the minifier's business, so match the values themselves.
checks.push(["the built bundle carries the package version", bundle.includes(pkg.version)]);
checks.push(["the built bundle carries the repository address", bundle.includes(pkg.repository)]);
checks.push(["package.json declares a repository to link to", typeof pkg.repository === "string" && pkg.repository.startsWith("https://")]);

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
