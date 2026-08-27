import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const confirmSource = fs.readFileSync(path.join(root, "src/components/steps/StepConfirm.vue"), "utf8");
const shellSource = fs.readFileSync(path.join(root, "src/components/WizardShell.vue"), "utf8");
const checks: Array<[string, boolean]> = [
  ["WizardShell provides the shared scroll area", /provide\(SHELL_SCROLL_AREA, scrollArea\)/.test(shellSource)],
  ["confirmation injects the shared scroll area", /inject\(SHELL_SCROLL_AREA\)/.test(confirmSource)],
  ["overflow requires reaching the bottom", /maxScrollTop <= 1 \|\| element\.scrollTop >= maxScrollTop - 1/.test(confirmSource)],
  ["the confirm button keeps both existing gates and the scroll gate", /lockSecondsLeft <= 0 && sessionOk && hasViewedEnd/.test(confirmSource)],
  ["scroll and content changes refresh the gate", /addEventListener\("scroll", checkViewedEnd/ .test(confirmSource) && /MutationObserver\(refreshViewedEnd\)/.test(confirmSource)],
  ["the user receives a bilingual scroll instruction", /confirm\.scrollToEnd/.test(confirmSource)],
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
