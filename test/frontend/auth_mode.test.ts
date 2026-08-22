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

// Two ways a deployment can authenticate — oauth and auto — chosen on a
// selector page that exists only when a recipe declares more than one and
// this Overture instance can actually complete both. Four things have to stay
// true: the wizard store's own reducers (availableAuthModes, hasAuthChoice,
// noAuthModeAvailable, setAuthMode, session sync) behave correctly under
// direct execution; the step components actually call them the way the store
// expects — checked by reading the component source, the same split
// test/frontend/wizard_guidance and wizard_steps already use for pages vs.
// store contract; auto mode's pre-filled token-creation link and permission
// list are built correctly from a recipe's declared permissions, against the
// same shared table the recipe schema validates against; and the danger
// callout fires for a permission the table marks dangerous and stays silent
// for one it doesn't.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createPinia, setActivePinia } from "pinia";
import { STEPS, useWizard } from "../../src/stores/wizard";
import { usePolicy } from "../../src/stores/policy";
import { buildTokenLinkUrl, describePermissions, mergeTokenPermissions, preflightPermissionsForChecks, CF_ACCOUNT_TOKENS_URL } from "../../src/lib/cf/tokenLink";
import type { AuthMode, Recipe, RecipeCheck } from "../../src/lib/recipe/types";
import { CF_ENDPOINTS } from "../../shared/cfAllowlist";
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

// Each block below gets its own fresh pinia: a store keeps working against the
// pinia it was created from even after another block activates a different
// one, but starting each block active avoids two blocks' stores tangling.

// ---- store-level behaviour: available modes = recipe ∩ server capability ---

setActivePinia(createPinia());
const wizardA = useWizard();
const policyA = usePolicy();

// auto is always available; oauth only when the operator configured a client.
policyA.policy.oauthEnabled = false;
wizardA.adoptConfig(configWith(recipeWith(["oauth", "auto"])));
const oauthHiddenWhenNotConfigured = [...wizardA.availableAuthModes];
const singleEffectiveModeChoice = wizardA.hasAuthChoice;

policyA.policy.oauthEnabled = true;
wizardA.adoptConfig(configWith(recipeWith(["oauth", "auto"])));
const bothModesWhenConfigured = [...wizardA.availableAuthModes];
const multiModeChoice = wizardA.hasAuthChoice;

// A recipe that only ever declared auto is unaffected by the oauth flag.
policyA.policy.oauthEnabled = false;
wizardA.adoptConfig(configWith(recipeWith(["auto"])));
const autoOnlyUnaffected = [...wizardA.availableAuthModes];

// A recipe that declared only oauth, on a server without it configured, has
// nothing usable — this is the one dead end the wizard has to block on.
wizardA.adoptConfig(configWith(recipeWith(["oauth"])));
const blockedWhenOauthOnlyAndUnconfigured = wizardA.noAuthModeAvailable;

policyA.policy.oauthEnabled = true;
wizardA.adoptConfig(configWith(recipeWith(["oauth"])));
const notBlockedOnceConfigured = wizardA.noAuthModeAvailable;

// oauth is narrowed further by the client's own scope ceiling: a needed scope
// the client was never registered to hold would fail at Cloudflare, so the mode
// is dropped rather than offered. A made-up scope stands in for one outside any
// real client's registration.
policyA.policy.oauthEnabled = true;
const scopeBeyond = { key: "beyond", requirement: "required" as const, oauthScopes: ["totally.madeup"] };
wizardA.adoptConfig(configWith({ ...recipeWith(["oauth", "auto"]), permissions: [scopeBeyond] }));
const oauthDroppedOnShortfall = [...wizardA.availableAuthModes];
const shortfallListed = [...wizardA.oauthScopeShortfall];

// The same shortfall when oauth is the only declared mode is a dead end to block.
wizardA.adoptConfig(configWith({ ...recipeWith(["oauth"]), permissions: [scopeBeyond] }));
const blockedOnShortfall = wizardA.noAuthModeAvailable;

// A declared scope that is within the ceiling keeps oauth on offer.
const scopeWithin = { key: "within", requirement: "required" as const, oauthScopes: ["d1.write"] };
wizardA.adoptConfig(configWith({ ...recipeWith(["oauth", "auto"]), permissions: [scopeWithin] }));
const oauthKeptWithinCeiling = [...wizardA.availableAuthModes];

// No recipe loaded yet is not the same as "blocked" — nothing to block on.
setActivePinia(createPinia());
const notBlockedBeforeAnyRecipe = useWizard().noAuthModeAvailable;

// ---- store-level behaviour: mode selection and session sync ----------------

setActivePinia(createPinia());
const wizardB = useWizard();
usePolicy().policy.oauthEnabled = true;

// adoptConfig resets the mode even if a previous recipe already set one.
wizardB.setAuthMode("auto");
wizardB.adoptConfig(configWith(recipeWith(["oauth", "auto"])));
const modeAfterReset = wizardB.authMode;

// setAuthMode drops a stale cfApiToken left by a mode the user is switching
// away from — otherwise a paste could get pushed under a mode it was never
// confirmed for.
wizardB.credentials.cfApiToken = "leftover-paste";
wizardB.setAuthMode("auto");
wizardB.credentials.cfApiToken = "fresh-paste";
wizardB.setAuthMode("oauth");
const cfApiTokenAfterModeSwitch = wizardB.credentials.cfApiToken;

// Each mode's own selector card reaches the authorize step with that mode set
// — the same two calls (setAuthMode, goTo(STEPS.authorize)) StepAuthMethod's
// own click handler makes, exercised here at the reducer level.
const reachability: Record<AuthMode, boolean> = { oauth: false, auto: false };
for (const authMode of ["oauth", "auto"] as const) {
  wizardB.goTo(STEPS.authMethod);
  wizardB.setAuthMode(authMode);
  wizardB.goTo(STEPS.authorize);
  reachability[authMode] = wizardB.step === STEPS.authorize && wizardB.authMode === authMode;
}

// The session read after a token submission or an OAuth callback carries the
// server's own record of the mode, and the store folds it back in.
wizardB.setAuthMode(null);
wizardB.applyOAuthSession({
  authorized: true,
  scope: [],
  accounts: [],
  accountId: null,
  pkg: null,
  expiresAt: null,
  mode: "auto",
});
const modeSyncedFromSession = wizardB.authMode;

// ---- component wiring (source-level) ---------------------------------------

const authMethodSource = read("src/components/steps/StepAuthMethod.vue");
const licenseSource = read("src/components/steps/StepLicense.vue");
const authorizeSource = read("src/components/steps/StepAuthorize.vue");
const deploySource = read("src/components/steps/StepDeploy.vue");
const relaySource = read("src/lib/relay.ts");

// ---- tokenLink: pre-filled URL and permission descriptions ------------------

const d1AndR2 = describePermissions([
  { key: "d1", type: "edit" },
  { key: "workers_r2", type: "read" },
]);
const dangerRow = describePermissions([{ key: "account_api_tokens", type: "edit" }])[0];
const billingRow = describePermissions([{ key: "billing", type: "edit" }])[0];
const billingReadRow = describePermissions([{ key: "billing", type: "read" }])[0];
const tokenReadRow = describePermissions([{ key: "account_api_tokens", type: "read" }])[0];

const accountChecks: RecipeCheck[] = [
  { id: "r2", requirement: "required", label: { "*": "R2 storage" }, path: "/accounts/${accountId}/r2/buckets" },
  { id: "images", requirement: "optional", label: { "*": "Image transforms" }, path: "/accounts/${accountId}/images/v1/stats" },
  { id: "r2Again", requirement: "recommended", label: { "*": "Existing buckets" }, path: "/accounts/${accountId}/r2/buckets" },
];
const preflightPermissions = preflightPermissionsForChecks(accountChecks);
const r2PreflightPermission = preflightPermissions.find((permission) => permission.key === "workers_r2");
const imagesPreflightPermission = preflightPermissions.find((permission) => permission.key === "images");
const mergedPermissions = mergeTokenPermissions(
  [{ key: "workers_r2", type: "edit" }],
  preflightPermissions,
  [{ key: "account_api_tokens", type: "read" }],
);
const getRulesWithoutPreflightRead = CF_ENDPOINTS.filter((rule) => rule.method === "GET" && !rule.accountTokenReadPermission);

const urlForEmpty = buildTokenLinkUrl([]);
const urlForOne = buildTokenLinkUrl([{ key: "d1", type: "edit" }]);
const decodedParam = (() => {
  const match = /permissionGroupKeys=([^&]+)/.exec(urlForOne);
  return match ? (JSON.parse(decodeURIComponent(match[1])) as Array<{ key: string; type: string }>) : null;
})();

let failures = 0;
const checks: Array<[string, boolean, string?]> = [
  ["oauth is dropped from the available modes when the server hasn't configured it",
    oauthHiddenWhenNotConfigured.length === 1 && oauthHiddenWhenNotConfigured[0] === "auto"],
  ["one available mode is not a choice", singleEffectiveModeChoice === false],
  ["oauth reappears once the server reports it configured", bothModesWhenConfigured.includes("oauth") && bothModesWhenConfigured.includes("auto")],
  ["two available modes is a real choice", multiModeChoice === true],
  ["a recipe declaring only auto is unaffected by the oauth flag", autoOnlyUnaffected.length === 1 && autoOnlyUnaffected[0] === "auto"],
  ["an oauth-only recipe on an unconfigured server has zero available modes", blockedWhenOauthOnlyAndUnconfigured === true],
  ["the same recipe is usable once the server configures oauth", notBlockedOnceConfigured === false],
  ["a needed scope outside the oauth client's ceiling drops oauth but keeps auto",
    oauthDroppedOnShortfall.length === 1 && oauthDroppedOnShortfall[0] === "auto"],
  ["the out-of-ceiling scope is surfaced for the not-available copy",
    shortfallListed.length === 1 && shortfallListed[0] === "totally.madeup"],
  ["an oauth-only recipe needing an out-of-ceiling scope has zero available modes", blockedOnShortfall === true],
  ["a declared scope within the ceiling keeps oauth available",
    oauthKeptWithinCeiling.length === 2 && oauthKeptWithinCeiling.includes("oauth")],
  ["no recipe loaded is not treated as a blocked deployment", notBlockedBeforeAnyRecipe === false],

  ["adoptConfig resets authMode to null for the newly loaded recipe", modeAfterReset === null],
  ["setAuthMode clears a stale cfApiToken from the mode being left", cfApiTokenAfterModeSwitch === ""],

  ["the oauth card's mode reaches the authorize step with oauth selected", reachability.oauth],
  ["the auto card's mode reaches the authorize step with auto selected", reachability.auto],

  ["applyOAuthSession folds the server's mode back into the store", modeSyncedFromSession === "auto"],

  ["the selector page only renders cards for modes this deployment can actually use",
    /availableAuthModes/.test(authMethodSource)],
  ["the selector page blocks continuing when nothing is available",
    /noAuthModeAvailable/.test(authMethodSource) && /notAvailable/.test(authMethodSource)],
  ["the selector page's card click sets the mode and advances to authorize",
    /setAuthMode/.test(authMethodSource) && /STEPS\.authorize/.test(authMethodSource)],

  ["the license page's skip logic uses the same available-modes list the selector page blocks on",
    /availableAuthModes/.test(licenseSource) && /setAuthMode/.test(licenseSource) && /STEPS\.authMethod/.test(licenseSource)],

  ["the authorize step's back button returns to the selector only when there was a choice to make",
    /hasAuthChoice[\s\S]{0,80}STEPS\.authMethod/.test(authorizeSource) || /STEPS\.authMethod[\s\S]{0,80}hasAuthChoice/.test(authorizeSource)],
  ["the authorize step keeps an auto-mode paste as the app's own credential",
    /authMode\s*!==\s*"auto"[\s\S]{0,60}return/.test(authorizeSource) && /credentials\.cfApiToken\s*=\s*value/.test(authorizeSource)],
  ["there is no manual mode left to branch on",
    !/["']manual["']/.test(authorizeSource) && !/["']manual["']/.test(authMethodSource)],
  ["the pre-filled token link and its permission list are built from the shared permission table",
    /buildTokenLinkUrl/.test(authorizeSource) && /describePermissions/.test(authorizeSource)],
  ["a declared danger permission drives its own warning block",
    /dangerPermissions/.test(authorizeSource) && /\.danger/.test(authorizeSource)],

  ["deploy no longer mints an application token", !/mintAppToken/.test(deploySource)],
  ["deploy no longer self-deletes a pasted token after success", !/revokeAuthToken/.test(deploySource)],
  ["the relay no longer exposes minting or self-delete, now that those Worker routes are gone",
    !/mintAppToken/.test(relaySource) && !/revoke-self/.test(relaySource)],
  ["submitAuthToken only ever sends mode \"auto\" now that manual has merged into it",
    /mode:\s*"auto"/.test(relaySource) && !/["']manual["']/.test(relaySource)],

  ["an empty permission list falls back to the bare account token page", urlForEmpty === CF_ACCOUNT_TOKENS_URL],
  ["a declared permission is encoded into permissionGroupKeys",
    !!decodedParam && decodedParam.length === 1 && decodedParam[0].key === "d1" && decodedParam[0].type === "edit"],
  ["permission rows carry the shared table's display name, not the raw key",
    d1AndR2[0].name === "D1" && d1AndR2[1].name === "Workers R2 Storage"],
  ["an edit on a flagged group (account_api_tokens) is reported as dangerous", dangerRow.danger === true],
  ["an edit on another flagged group (billing) is reported as dangerous too", billingRow.danger === true],
  ["a read on a flagged group (billing) is not dangerous — only writing it is", billingReadRow.danger === false],
  ["a read on the token group (account_api_tokens) is not dangerous", tokenReadRow.danger === false],
  ["an ordinary permission (D1) is not reported as dangerous", d1AndR2[0].danger === false],
  ["an R2 pre-check automatically adds Workers R2 Storage read", r2PreflightPermission?.type === "read" && r2PreflightPermission.requirement === "required"],
  ["one read permission lists every check it covers", r2PreflightPermission?.checks.map((check) => check.id).join(",") === "r2,r2Again"],
  ["an optional Images check keeps its generated read optional", imagesPreflightPermission?.type === "read" && imagesPreflightPermission.requirement === "optional"],
  ["an app edit and a pre-check read for the same group become one edit request", mergedPermissions.filter((permission) => permission.key === "workers_r2").length === 1 && mergedPermissions.find((permission) => permission.key === "workers_r2")?.type === "edit"],
  ["every allow-listed GET that a recipe may use as a check declares its account-token read", getRulesWithoutPreflightRead.length === 0, getRulesWithoutPreflightRead.map((rule) => rule.id).join(", ")],
  ["the authorize page presents generated reads as account pre-check requirements", /preflightPermissionsForChecks/.test(authorizeSource) && /checkPermissionsTitle/.test(authorizeSource)],
];

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
