// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const shellSource = fs.readFileSync(path.join(root, "src/components/WizardShell.vue"), "utf8");

const checks: Array<[string, boolean]> = [
  ["the shell uses the public Fluent scroll viewer", /<FluentScrollViewer\s+ref="scrollViewer"\s+class="shell-card-scroll"/.test(shellSource)],
  ["the shared scroll area references the public viewport API", /scrollViewer\.value\?\.element\(\) \?\? null/.test(shellSource)],
  ["top-level page changes reset the viewport and cancel pending scroll animation",
    /watch\(\s*\(\)\s*=>\s*props\.step,[\s\S]*?scrollViewer\.value\?\.scrollTo\(\{ left: 0, top: 0 \}\)[\s\S]*?flush:\s*"post"/.test(shellSource)],
  ["the reset is not tied to deployment sub-step progress", !/executeProgress[\s\S]*?scrollViewer\.value\?\.scrollTo/.test(shellSource)],
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
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
