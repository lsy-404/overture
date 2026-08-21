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

// recipe.json arrives from a third-party repository, so the validator is the
// only thing standing between a crafted package and the wizard. Every check
// here is a rejection the deploy depends on.

import { validateRecipe } from "../../src/lib/recipe/schema";
import { RECIPE_LIMITS } from "../../src/lib/recipe/types";
import { PACKAGE_ARTIFACT_NAME } from "../../shared/package";

type Json = Record<string, unknown>;

const VALID_SHA256 = "a".repeat(64);

function minimal(): Json {
  return {
    schema: 2,
    id: "demo",
    name: "Demo",
    summary: { en: "A demo package", "*": "A demo package" },
    version: "1.0.0",
    tag: "v1.0.0",
    buildTime: "2026-01-01T00:00:00Z",
    package: { artifact: PACKAGE_ARTIFACT_NAME, sha256: VALID_SHA256 },
    license: { id: "AGPL-3.0-or-later", text: "Full licence text." },
    authModes: ["oauth"],
    permissions: [
      {
        key: "scripts",
        requirement: "required",
        oauthScopes: ["workers-scripts.write"],
        label: { en: "Workers Scripts" },
        scenario: { en: "Upload the Worker" },
        scope: "account",
        level: "write",
      },
    ],
    resources: [resource("db", "DB")],
    worker: { defaultName: "demo", module: "worker/index.js" },
    capabilities: ["d1", "worker"],
    steps: [{ id: "upload", label: { en: "Upload" } }],
  };
}

function resource(id: string, binding: string): Json {
  return {
    id,
    kind: "d1",
    binding,
    defaultName: "${worker}-db",
    required: true,
    label: { en: id },
  };
}

function step(id: string): Json {
  return { id, label: { en: id } };
}

function input(id: string): Json {
  return { id, kind: "text", label: { en: id } };
}

/** A recipe built from the minimal one with `mutate` applied. */
function tweak(mutate: (recipe: Json) => void): Json {
  const recipe = structuredClone(minimal());
  mutate(recipe);
  return recipe;
}

const accepts = (recipe: unknown) => validateRecipe(recipe).ok;
const rejects = (recipe: unknown) => !validateRecipe(recipe).ok;

function errorsOf(recipe: unknown): string[] {
  const result = validateRecipe(recipe);
  return result.ok ? [] : result.errors;
}

const ESCAPING_PATHS = ["../x", "../../etc/passwd", "/etc/passwd", "a\\b", "./../x", ""];

const checks: Array<[string, boolean, string?]> = [
  ["a minimal recipe validates", accepts(minimal()), errorsOf(minimal()).join("; ")],

  ["a missing schema is rejected", rejects(tweak((r) => delete r.schema))],
  ["a schema other than the current one is rejected",
    rejects(tweak((r) => (r.schema = 1))) && rejects(tweak((r) => (r.schema = 3))) && rejects(tweak((r) => (r.schema = "2")))],

  // Scopes are what the consent screen will list, so a package cannot name one
  // this deployment's OAuth client was never registered to hold.
  ["a scope outside the registered ceiling is rejected",
    rejects(tweak((r) => ((r.permissions as Json[])[0].oauthScopes = ["workers-scripts.write", "not-a-scope.write"])))
    && rejects(tweak((r) => ((r.permissions as Json[])[0].oauthScopes = ["Workers Scripts Write"])))],
  ["an authority OAuth cannot grant is allowed to name no scope",
    accepts(tweak((r) => ((r.permissions as Json[])[0].oauthScopes = [])))],
  ["a duplicated scope is rejected",
    rejects(tweak((r) => ((r.permissions as Json[])[0].oauthScopes = ["d1.read", "d1.read"])))],

  // authModes declares which authentication modes the package supports.
  ["a missing authModes is rejected", rejects(tweak((r) => delete r.authModes))],
  ["an empty authModes is rejected", rejects(tweak((r) => (r.authModes = [])))],
  ["an unknown authMode is rejected", rejects(tweak((r) => (r.authModes = ["oauth", "nope"])))],
  ["a duplicated authMode is rejected", rejects(tweak((r) => (r.authModes = ["oauth", "oauth"])))],
  ["both modes together validate", accepts(tweak((r) => (r.authModes = ["oauth", "auto"])))],
  ["the removed manual mode is rejected", rejects(tweak((r) => (r.authModes = ["manual"])))],

  // A cfApiToken host secret is a long-lived app credential; oauth alone cannot
  // furnish it, and its permissions (template `{key,type}`) are required and
  // exclusive to that source, each key within the CF_TOKEN_PERMISSIONS ceiling.
  ["a cfApiToken host secret with permissions and an auto mode validates",
    accepts(tweak((r) => {
      r.authModes = ["auto"];
      r.hostSecrets = [{ name: "CF_API_TOKEN", source: "cfApiToken", permissions: [{ key: "workers_scripts", type: "edit" }],
        reason: { en: "self-manage" }, requirement: "required" }];
    }))],
  ["a cfApiToken host secret under oauth-only is rejected",
    rejects(tweak((r) => {
      r.authModes = ["oauth"];
      r.hostSecrets = [{ name: "CF_API_TOKEN", source: "cfApiToken", permissions: [{ key: "workers_scripts", type: "edit" }],
        reason: { en: "self-manage" }, requirement: "required" }];
    }))],
  ["a cfApiToken host secret without permissions is rejected",
    rejects(tweak((r) => {
      r.authModes = ["auto"];
      r.hostSecrets = [{ name: "CF_API_TOKEN", source: "cfApiToken", reason: { en: "x" }, requirement: "required" }];
    }))],
  ["a cfApiToken permission key outside the table is rejected",
    rejects(tweak((r) => {
      r.authModes = ["auto"];
      r.hostSecrets = [{ name: "CF_API_TOKEN", source: "cfApiToken", permissions: [{ key: "not_a_real_key", type: "edit" }],
        reason: { en: "x" }, requirement: "required" }];
    }))],
  ["permissions on a non-cfApiToken host secret is rejected",
    rejects(tweak((r) => {
      r.hostSecrets = [{ name: "CF_ACCOUNT_ID", source: "accountId", permissions: [{ key: "d1", type: "read" }], reason: { en: "x" }, requirement: "required" }];
    }))],
  ["a non-object input is rejected", rejects(null) && rejects("{}") && rejects([]) && rejects(42)],

  ["a worker without an entry module is rejected",
    rejects(tweak((r) => delete (r.worker as Json).module))
    && rejects(tweak((r) => (r.worker = { defaultName: "demo" })))
    && rejects(tweak((r) => delete r.worker))],

  ["package paths may not escape the package",
    ESCAPING_PATHS.every((path) => rejects(tweak((r) => ((r.worker as Json).module = path))))],

  ["the package artifact must be the fixed artifact name",
    rejects(tweak((r) => ((r.package as Json).artifact = "custom.tar.gz")))
    && accepts(tweak((r) => ((r.package as Json).artifact = PACKAGE_ARTIFACT_NAME)))],
  ["the package digest must be a 64-character hex string",
    ["short", "g".repeat(64), "a".repeat(63), "a".repeat(65), ""].every((sha256) =>
      rejects(tweak((r) => ((r.package as Json).sha256 = sha256))))],

  ["a plain package-relative path is accepted",
    accepts(tweak((r) => ((r.worker as Json).module = "worker/index.js")))
    && accepts(tweak((r) => ((r.worker as Json).assetsManifest = "assets-manifest.json")))],

  ["illegal ids are rejected",
    ["Upper", "has space", "-leading", "a/b", "", "x".repeat(64)].every((id) =>
      rejects(tweak((r) => (r.resources = [resource(id, "DB")]))))
    && rejects(tweak((r) => (r.id = "Bad Id")))
    && rejects(tweak((r) => (r.steps = [step("Bad Step")])))],
  ["illegal binding names are rejected",
    ["1bad", "has-dash", "has space", "", "B".repeat(65)].every((binding) =>
      rejects(tweak((r) => (r.resources = [resource("db", binding)]))))],
  ["a legal binding name is accepted", accepts(tweak((r) => (r.resources = [resource("db", "_DB_2")])))],

  // A match declaration decides which existing resource a deployment writes
  // into, so an unusable one has to be a rejected package rather than a rule
  // that silently never fires.
  ["a resource match declaration is accepted",
    accepts(tweak((r) => ((r.resources as Json[])[0].match = { names: ["${worker}-old", "legacy-db"], patterns: ["^acme-db-\\d+$"] })))
    && accepts(tweak((r) => ((r.resources as Json[])[0].match = { names: ["legacy-db"] })))
    && accepts(tweak((r) => ((r.resources as Json[])[0].match = { patterns: ["^x$"] }))),
    errorsOf(tweak((r) => ((r.resources as Json[])[0].match = { names: ["legacy-db"] }))).join("; ")],

  ["an empty match declaration is rejected",
    rejects(tweak((r) => ((r.resources as Json[])[0].match = {})))
    && rejects(tweak((r) => ((r.resources as Json[])[0].match = { names: [], patterns: [] })))],

  ["a match pattern that is not a regular expression is rejected",
    rejects(tweak((r) => ((r.resources as Json[])[0].match = { patterns: ["a("] })))
    && rejects(tweak((r) => ((r.resources as Json[])[0].match = { patterns: ["x".repeat(RECIPE_LIMITS.maxPatternChars + 1)] })))],

  ["a match name that could not be a Cloudflare name is rejected",
    ["Upper", "has space", "a/b"].every((name) =>
      rejects(tweak((r) => ((r.resources as Json[])[0].match = { names: [name] }))))],

  ["too many match entries are rejected",
    rejects(tweak((r) => ((r.resources as Json[])[0].match = {
      names: Array.from({ length: RECIPE_LIMITS.maxMatchNames + 1 }, (_, index) => `old-${index}`),
    })))
    && rejects(tweak((r) => ((r.resources as Json[])[0].match = {
      patterns: Array.from({ length: RECIPE_LIMITS.maxMatchPatterns + 1 }, (_, index) => `^old-${index}$`),
    })))],

  ["duplicate resource ids are rejected",
    rejects(tweak((r) => (r.resources = [resource("db", "DB"), resource("db", "OTHER")])))],
  ["duplicate step ids are rejected", rejects(tweak((r) => (r.steps = [step("upload"), step("upload")])))],
  ["duplicate input ids are rejected", rejects(tweak((r) => (r.inputs = [input("name"), input("name")])))],
  ["duplicate resource bindings are rejected",
    rejects(tweak((r) => (r.resources = [resource("db", "DB"), resource("other", "DB")])))],

  ["an unknown capability is rejected",
    rejects(tweak((r) => (r.capabilities = ["d1", "network"])))
    && rejects(tweak((r) => (r.capabilities = ["D1"])))
    && rejects(tweak((r) => (r.capabilities = "d1")))],

  ["an unknown host secret source is rejected",
    rejects(tweak((r) => (r.hostSecrets = [
      { name: "CF_TOKEN", source: "sessionStorage", requirement: "required", reason: { en: "why" } },
    ])))],
  // C-1: a recipe cannot declare a host secret sourced from the session
  // credential — it would let a package's own Worker exfiltrate the OAuth
  // session, HttpOnly cookie or not, the moment the recipe pushes it as one
  // of its own Workers Secrets.
  ["\"apiToken\" as a host secret source is rejected",
    rejects(tweak((r) => (r.hostSecrets = [
      { name: "CF_TOKEN", source: "apiToken", requirement: "required", reason: { en: "why" } },
    ])))],
  ["a known host secret source is accepted",
    accepts(tweak((r) => (r.hostSecrets = [
      { name: "CF_ACCOUNT_ID", source: "accountId", requirement: "required", reason: { en: "why" } },
    ])))],

  ["a requirement outside the three levels is rejected",
    rejects(tweak((r) => ((r.permissions as Json[])[0].requirement = "mandatory")))],

  ["counts past RECIPE_LIMITS are rejected",
    rejects(tweak((r) => (r.resources = Array.from({ length: RECIPE_LIMITS.maxResources + 1 }, (_, i) => resource(`db${i}`, `DB${i}`)))))
    && rejects(tweak((r) => (r.steps = Array.from({ length: RECIPE_LIMITS.maxSteps + 1 }, (_, i) => step(`s${i}`)))))
    && rejects(tweak((r) => (r.inputs = Array.from({ length: RECIPE_LIMITS.maxInputs + 1 }, (_, i) => input(`i${i}`)))))
    && rejects(tweak((r) => (r.permissions = Array.from({ length: RECIPE_LIMITS.maxPermissions + 1 }, (_, i) => ({
      ...(minimal().permissions as Json[])[0], key: `p${i}`,
    })))))],
  ["counts at the limit are still accepted",
    accepts(tweak((r) => (r.steps = Array.from({ length: RECIPE_LIMITS.maxSteps }, (_, i) => step(`s${i}`)))))],

  ["every fault is reported, not just the first",
    (() => {
      const errors = errorsOf(tweak((r) => {
        delete r.schema;
        delete (r.worker as Json).module;
        r.id = "Bad Id";
        r.capabilities = ["network"];
      }));
      return errors.length >= 4 && errors.every((message) => typeof message === "string" && message.length > 0);
    })()],
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
