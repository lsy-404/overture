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

// Three ways a deployment can authenticate, chosen on a selector page that
// exists only when a recipe actually offers more than one. Two things have to
// stay true: the wizard store's own reducers (hasAuthChoice, setAuthMode,
// session sync) behave correctly under direct execution, and the step
// components actually call them the way the store expects — checked by
// reading the component source, the same split test/frontend/wizard_guidance
// and wizard_steps already use for pages vs. store contract.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createPinia, setActivePinia } from "pinia";
import { STEPS, useWizard } from "../../src/stores/wizard";
import type { AuthMode, Recipe } from "../../src/lib/recipe/types";
import type { LoadedConfig } from "../../src/lib/package/config";
import { PACKAGE_ARTIFACT_NAME } from "../../shared/package";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function read(file: string): string {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function recipeWith(authModes: AuthMode[], hostSecrets?: Recipe["hostSecrets"]): Recipe {
  return {
    schema: 2,
    id: "demo",
    name: "Demo",
    summary: "A demo package",
    version: "1.0.0",
    tag: "v1.0.0",
    buildTime: "2026-01-01T00:00:00Z",
    package: { artifact: PACKAGE_ARTIFACT_NAME, sha256: "a".repeat(64) },
    license: { id: "AGPL-3.0-or-later", text: "Full licence text." },
    authModes,
    permissions: [],
    resources: [],
    worker: { defaultName: "demo", module: "worker/index.js" },
    capabilities: [],
    steps: [{ id: "upload", label: "Upload" }],
    ...(hostSecrets ? { hostSecrets } : {}),
  };
}

function configWith(recipe: Recipe): LoadedConfig {
  return { ref: { owner: "acme", repo: "demo" }, tag: "v1.0.0", recipe, licenseText: "", termsText: "" };
}

setActivePinia(createPinia());
const wizard = useWizard();

// ---- store-level behaviour --------------------------------------------------

wizard.adoptConfig(configWith(recipeWith(["oauth"])));
const singleModeChoice = wizard.hasAuthChoice;

wizard.adoptConfig(configWith(recipeWith(["oauth", "auto", "manual"])));
const multiModeChoice = wizard.hasAuthChoice;

// adoptConfig resets the mode even if a previous recipe already set one.
wizard.setAuthMode("manual");
wizard.adoptConfig(configWith(recipeWith(["oauth", "auto"])));
const modeAfterReset = wizard.authMode;

// setAuthMode drops a stale cfApiToken left by a mode the user is switching
// away from — otherwise a manual paste could get pushed under a mode it was
// never confirmed for.
wizard.credentials.cfApiToken = "leftover-from-manual";
wizard.setAuthMode("auto");
const cfApiTokenAfterModeSwitch = wizard.credentials.cfApiToken;

// Each mode's own selector card reaches the authorize step with that mode set
// — the same two calls (setAuthMode, goTo(STEPS.authorize)) StepAuthMethod's
// own click handler makes, exercised here at the reducer level.
const reachability: Record<AuthMode, boolean> = { oauth: false, auto: false, manual: false };
for (const authMode of ["oauth", "auto", "manual"] as const) {
  wizard.goTo(STEPS.authMethod);
  wizard.setAuthMode(authMode);
  wizard.goTo(STEPS.authorize);
  reachability[authMode] = wizard.step === STEPS.authorize && wizard.authMode === authMode;
}

// The session read after a token submission or an OAuth callback carries the
// server's own record of the mode, and the store folds it back in.
wizard.setAuthMode(null);
wizard.applyOAuthSession({
  authorized: true,
  scope: [],
  accounts: [],
  accountId: null,
  pkg: null,
  expiresAt: null,
  mode: "auto",
});
const modeSyncedFromSession = wizard.authMode;

// ---- component wiring (source-level) ---------------------------------------

const authMethodSource = read("src/components/steps/StepAuthMethod.vue");
const licenseSource = read("src/components/steps/StepLicense.vue");
const authorizeSource = read("src/components/steps/StepAuthorize.vue");
const deploySource = read("src/components/steps/StepDeploy.vue");

const checks: Array<[string, boolean, string?]> = [
  ["hasAuthChoice is false for a recipe declaring exactly one mode", singleModeChoice === false],
  ["hasAuthChoice is true for a recipe declaring more than one mode", multiModeChoice === true],
  ["adoptConfig resets authMode to null for the newly loaded recipe", modeAfterReset === null],
  ["setAuthMode clears a stale cfApiToken from the mode being left", cfApiTokenAfterModeSwitch === ""],

  ["the oauth card's mode reaches the authorize step with oauth selected", reachability.oauth],
  ["the auto card's mode reaches the authorize step with auto selected", reachability.auto],
  ["the manual card's mode reaches the authorize step with manual selected", reachability.manual],

  ["applyOAuthSession folds the server's mode back into the store", modeSyncedFromSession === "auto"],

  ["the selector page only renders cards for modes the recipe actually declared",
    /authModes/.test(authMethodSource) && /\.includes\(/.test(authMethodSource)],
  ["the selector page's card click sets the mode and advances to authorize",
    /setAuthMode/.test(authMethodSource) && /STEPS\.authorize/.test(authMethodSource)],

  ["the license page skips the selector when there is no real choice, and sets the sole mode directly",
    /hasAuthChoice/.test(licenseSource) && /setAuthMode/.test(licenseSource) && /STEPS\.authMethod/.test(licenseSource)],

  ["the authorize step's back button returns to the selector only when there was a choice to make",
    /hasAuthChoice[\s\S]{0,80}STEPS\.authMethod/.test(authorizeSource) || /STEPS\.authMethod[\s\S]{0,80}hasAuthChoice/.test(authorizeSource)],
  ["the authorize step keeps a manual paste as the app's own credential",
    /mode === "manual"[\s\S]{0,120}credentials\.cfApiToken\s*=\s*value/.test(authorizeSource)],
  ["the authorize step never assigns the auto-mode paste to a stored credential",
    !/mode === "auto"[\s\S]{0,200}credentials\.cfApiToken\s*=/.test(authorizeSource)],

  ["deploy mints the app token only in auto mode, and only when the recipe declares one",
    /authMode === "auto"[\s\S]{0,200}cfApiTokenSecret\.value[\s\S]{0,200}mintAppToken/.test(deploySource)],
  ["deploy deletes the pasted powerful token after a successful auto-mode run, not before",
    (() => {
      const resultAt = deploySource.indexOf("wizard.result = result");
      const revokeAt = deploySource.indexOf("revokeAuthToken()");
      return resultAt >= 0 && revokeAt > resultAt;
    })()],
  ["a failed self-delete surfaces a note rather than staying silent",
    /autoTokenCleanupFailed/.test(deploySource)],
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
